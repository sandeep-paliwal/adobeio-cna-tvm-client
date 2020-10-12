/*
Copyright 2019 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

const cloneDeep = require('lodash.clonedeep')

const fs = require('fs-extra')
jest.mock('fs-extra')

const fetch = require('node-fetch')
jest.mock('node-fetch')

const crypto = require('crypto')
jest.mock('crypto')

const networkingLib = require('@adobe/aio-lib-core-networking')

const mockLogDebug = jest.fn()
const mockLogError = jest.fn()
jest.doMock('@adobe/aio-lib-core-logging', function () {
  return function () {
    return {
      debug: mockLogDebug,
      error: mockLogError
    }
  }
})

// must be after mock logging block, todo find cleaner way
const TvmClient = require('../')

const maxDate = new Date(8640000000000000).toISOString()
const minDate = new Date(-8640000000000000).toISOString()

let fakeTVMInput
let fakeAzureTVMResponse
let fakeAwsS3Response
let cacheContent
let fakeAzureCosmosResponse
let fakeAzureTVMPresignResponse

const wrapInFetchResponse = (body) => {
  return {
    ok: true,
    json: async () => body
  }
}
const wrapInFetchError = (status) => {
  return {
    ok: false,
    json: async () => 'error',
    text: async () => 'error',
    status
  }
}

const setCacheKey = (input) => crypto.createHash.mockReturnValue({
  update: () => ({
    digest: () => input
  })
})

beforeEach(async () => {
  expect.hasAssertions()
  jest.resetAllMocks()
  jest.setTimeout(5000)
  fs.readFile.mockReset()
  fs.writeFile.mockReset()

  fetch.mockReset()
  crypto.createHash.mockReset()

  mockLogDebug.mockReset()
  mockLogError.mockReset()
  // mockLogging.
  fakeTVMInput = {
    ow: {
      namespace: 'fakens',
      auth: 'fakeauth'
    }
  }
  TvmClient.inMemoryCache = null
  fakeAzureTVMResponse = {
    expiration: maxDate,
    sasURLPrivate: 'https://fake.com',
    sasURLPublic: 'https://fake.com'
  }
  fakeAzureTVMPresignResponse = {
    signature: 'fakesign'
  }
  fakeAwsS3Response = {
    expiration: maxDate,
    accessKeyId: 'fake',
    secretAccessKey: 'fake',
    sessionToken: 'fake',
    params: { Bucket: 'fake' }
  }
  fakeAzureCosmosResponse = {
    expiration: maxDate,
    endpoint: 'https://fake.com',
    resourceTokens: 'fake',
    partitionKey: 'fake',
    databaseId: 'fakeDB',
    containerId: 'fakeContainer'
  }
  setCacheKey('fakeCacheKey')
  cacheContent = JSON.stringify({ fakeCacheKey: fakeAzureTVMResponse })
  delete process.env.__OW_API_KEY
  delete process.env.__OW_NAMESPACE
})

describe('init', () => {
  describe('with bad arguments', () => {
    test('missing ow object', async () => {
      fakeTVMInput.ow = undefined
      const instantiate = async () => TvmClient.init(fakeTVMInput)
      await expect(instantiate).toThrowBadArgWithMessageContaining(['ow', 'required'])
    })
    test('unknown config key', async () => {
      fakeTVMInput.badKey = 'smthg'
      const instantiate = async () => TvmClient.init(fakeTVMInput)
      await expect(instantiate).toThrowBadArgWithMessageContaining(['badKey', 'not allowed'])
    })
  })
  describe('logging', () => {
    test('when there are no init errors', async () => {
      await TvmClient.init(fakeTVMInput)
      expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(fakeTVMInput.ow.namespace))
      expect(mockLogDebug).toHaveBeenCalledWith(expect.not.stringContaining(fakeTVMInput.ow.auth))
      // defaults must be logged
      expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining('default'))
      expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(TvmClient.DefaultTVMCacheFile))
      expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(TvmClient.DefaultApiHost))
    })
    test('when there is an init errors', async () => {
      fakeTVMInput.badKey = 'smthg'
      try { await TvmClient.init(fakeTVMInput) } catch (e) {}
      expect(mockLogError).toHaveBeenCalledTimes(1)
      expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining(fakeTVMInput.ow.namespace))
      expect(mockLogError).toHaveBeenCalledWith(expect.not.stringContaining(fakeTVMInput.ow.auth))
    })
  })
  describe('api url', () => {
    test('when not specified', async () => {
      const tvm = await TvmClient.init(cloneDeep(fakeTVMInput))
      expect(tvm.apiUrl).toEqual(TvmClient.DefaultApiHost)
    })
    test('when specified', async () => {
      const apiUrl = 'https://fake.com'
      const tvm = await TvmClient.init({ ...fakeTVMInput, apiUrl })
      expect(tvm.apiUrl).toEqual(apiUrl)
    })
  })
  describe('pass ow through env', () => {
    test('when passing auth in __OW_API_KEY', async () => {
      process.env.__OW_API_KEY = fakeTVMInput.ow.auth
      delete fakeTVMInput.ow.auth
      const tvm = await TvmClient.init(fakeTVMInput)
      expect(tvm.apiUrl).toEqual(TvmClient.DefaultApiHost)
    })
    test('when passing namespace in __OW_NAMESPACE', async () => {
      process.env.__OW_NAMESPACE = fakeTVMInput.ow.namespace
      delete fakeTVMInput.ow.namespace
      const tvm = await TvmClient.init(fakeTVMInput)
      expect(tvm.apiUrl).toEqual(TvmClient.DefaultApiHost)
    })
    test('when passing both namespace and auth in __OW_NAMESPACE and __OW_API_KEY', async () => {
      process.env.__OW_API_KEY = fakeTVMInput.ow.auth
      process.env.__OW_NAMESPACE = fakeTVMInput.ow.namespace
      const tvm = await TvmClient.init()
      expect(tvm.apiUrl).toEqual(TvmClient.DefaultApiHost)
    })
  })
})

describe('getAzurePresignCredentials', () => {
  const fetchTvmPresignLog = 'successfully fetched presign credentials from tvm for'
  const options = {
    blobName: 'fakefile',
    expiryInSeconds: 60,
    permissions: 'fake'
  }
  test('when tvm response is valid', async () => {
    // fake the fetch to the TVM
    fetch.mockResolvedValue(wrapInFetchResponse(fakeAzureTVMPresignResponse))
    fakeTVMInput.cacheFile = false
    const tvmClient = await TvmClient.init(fakeTVMInput)
    const creds = await tvmClient.getAzureBlobPresignCredentials(options)
    expect(creds).toEqual(fakeAzureTVMPresignResponse)
    // calls with namespace as path arg
    expect(fetch.mock.calls[0][0].toString()).toEqual(TvmClient.DefaultApiHost + '/' +
      TvmClient.AzurePresignEndpoint + '/' + fakeTVMInput.ow.namespace + '?expiryInSeconds=60&blobName=fakefile&permissions=fake')
    // adds Authorization header
    expect(fetch.mock.calls[0][1].headers).toEqual(expect.objectContaining({ Authorization: fakeTVMInput.ow.auth }))
    expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(fetchTvmPresignLog))
  })
  test('when tvm response has a client error', async () => {
    // fake the fetch to the TVM
    fetch.mockResolvedValue(wrapInFetchError(400))
    fakeTVMInput.cacheFile = false
    const tvmClient = await TvmClient.init(fakeTVMInput)
    await expect(tvmClient.getAzureBlobPresignCredentials(options)).rejects.toThrow('[TvmLib:ERROR_RESPONSE] Error response from TVM server with status code: 400')
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining(fakeTVMInput.ow.namespace))
    expect(mockLogError).toHaveBeenCalledWith(expect.not.stringContaining(fakeTVMInput.ow.auth))
  })
  test('when tvm fetch is unauthorized', async () => {
    // fake the fetch to the TVM
    fetch.mockResolvedValue(wrapInFetchError(401))
    fakeTVMInput.cacheFile = false
    const tvmClient = await TvmClient.init(fakeTVMInput)
    await expect(tvmClient.getAzureBlobPresignCredentials(options)).rejects.toThrow('[TvmLib:ERROR_RESPONSE] Error response from TVM server with status code: 401')
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining(fakeTVMInput.ow.namespace))
    expect(mockLogError).toHaveBeenCalledWith(expect.not.stringContaining(fakeTVMInput.ow.auth))
  })

  test('when tvm fetch with no options', async () => {
    // fake the fetch to the TVM
    fetch.mockResolvedValue(wrapInFetchError(401))
    fakeTVMInput.cacheFile = false
    const tvmClient = await TvmClient.init(fakeTVMInput)
    await expect(tvmClient.getAzureBlobPresignCredentials()).rejects.toThrow('[TvmLib:ERROR_MISSING_OPTION] missing one or more of required options blobName, expiryInSeconds and permissions')
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('ERROR_MISSING_OPTION'))
  })

  test('when tvm fetch with only expiry options', async () => {
    // fake the fetch to the TVM
    fetch.mockResolvedValue(wrapInFetchError(401))
    fakeTVMInput.cacheFile = false
    const tvmClient = await TvmClient.init(fakeTVMInput)
    await expect(tvmClient.getAzureBlobPresignCredentials({ expiryInSeconds: 60 })).rejects.toThrow('[TvmLib:ERROR_MISSING_OPTION] missing one or more of required options blobName, expiryInSeconds and permissions')
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('ERROR_MISSING_OPTION'))
  })

  test('when tvm fetch with only blobName', async () => {
    // fake the fetch to the TVM
    fetch.mockResolvedValue(wrapInFetchError(401))
    fakeTVMInput.cacheFile = false
    const tvmClient = await TvmClient.init(fakeTVMInput)
    await expect(tvmClient.getAzureBlobPresignCredentials({ blobName: 'fake' })).rejects.toThrow('[TvmLib:ERROR_MISSING_OPTION] missing one or more of required options blobName, expiryInSeconds and permissions')
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('ERROR_MISSING_OPTION'))
  })
})

describe('revokeAzureBlobPresignCredentials', () => {
  const fetchTvmPresignLog = 'successfully revoked presign credentials from tvm'

  test('when tvm response is valid', async () => {
    // fake the fetch to the TVM
    fetch.mockResolvedValue(wrapInFetchResponse(fakeAzureTVMPresignResponse))
    fakeTVMInput.cacheFile = false
    const tvmClient = await TvmClient.init(fakeTVMInput)
    const creds = await tvmClient.revokeAzureBlobPresignCredentials()
    expect(creds).toEqual(fakeAzureTVMPresignResponse)
    // calls with namespace as path arg
    expect(fetch.mock.calls[0][0].toString()).toEqual(TvmClient.DefaultApiHost + '/' +
      TvmClient.AzureRevokePresignEndpoint + '/' + fakeTVMInput.ow.namespace)
    // adds Authorization header
    expect(fetch.mock.calls[0][1].headers).toEqual(expect.objectContaining({ Authorization: fakeTVMInput.ow.auth }))
    expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(fetchTvmPresignLog))
  })
  test('when tvm response has a client error', async () => {
    // fake the fetch to the TVM
    fetch.mockResolvedValue(wrapInFetchError(400))
    fakeTVMInput.cacheFile = false
    const tvmClient = await TvmClient.init(fakeTVMInput)
    await expect(tvmClient.revokeAzureBlobPresignCredentials()).rejects.toThrow('[TvmLib:ERROR_RESPONSE] Error response from TVM server with status code: 400')
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining(fakeTVMInput.ow.namespace))
    expect(mockLogError).toHaveBeenCalledWith(expect.not.stringContaining(fakeTVMInput.ow.auth))
  })
  test('when tvm fetch is unauthorized', async () => {
    // fake the fetch to the TVM
    fetch.mockResolvedValue(wrapInFetchError(401))
    fakeTVMInput.cacheFile = false
    const tvmClient = await TvmClient.init(fakeTVMInput)
    await expect(tvmClient.revokeAzureBlobPresignCredentials()).rejects.toThrow('[TvmLib:ERROR_RESPONSE] Error response from TVM server with status code: 401')
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining(fakeTVMInput.ow.namespace))
    expect(mockLogError).toHaveBeenCalledWith(expect.not.stringContaining(fakeTVMInput.ow.auth))
  })
})

describe('getAzureBlobCredentials', () => {
  const readCacheLog = 'read credentials from cache file'
  const writeCacheLog = 'wrote credentials to cache file'
  const fetchTvmLog = 'fetched credentials from tvm'
  const expiredCacheLog = 'expired'
  describe('without caching cacheFile=false', () => {
    test('when tvm response is valid', async () => {
      // fake the fetch to the TVM
      fetch.mockResolvedValue(wrapInFetchResponse(fakeAzureTVMResponse))
      fakeTVMInput.cacheFile = false
      const tvmClient = await TvmClient.init(fakeTVMInput)
      const creds = await tvmClient.getAzureBlobCredentials()
      expect(creds).toEqual(fakeAzureTVMResponse)
      // calls with namespace as path arg
      expect(fetch.mock.calls[0][0]).toEqual(TvmClient.DefaultApiHost + '/' + TvmClient.AzureBlobEndpoint + '/' + fakeTVMInput.ow.namespace)
      // adds Authorization header
      expect(fetch.mock.calls[0][1].headers).toEqual(expect.objectContaining({ Authorization: fakeTVMInput.ow.auth }))
      expect(fs.readFile).toHaveBeenCalledTimes(0)
      expect(fs.writeFile).toHaveBeenCalledTimes(0)
      expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(fetchTvmLog))
    })
    test('when tvm response has a client error', async () => {
      // fake the fetch to the TVM
      fetch.mockResolvedValue(wrapInFetchError(400))
      fakeTVMInput.cacheFile = false
      const tvmClient = await TvmClient.init(fakeTVMInput)
      await expect(tvmClient.getAzureBlobCredentials.bind(tvmClient)).toThrowStatusError(400)
      expect(fs.readFile).toHaveBeenCalledTimes(0)
      expect(fs.writeFile).toHaveBeenCalledTimes(0)
      expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining(fakeTVMInput.ow.namespace))
      expect(mockLogError).toHaveBeenCalledWith(expect.not.stringContaining(fakeTVMInput.ow.auth))
    })
    test('when tvm response has a server error with default maxRetries and initialDelayInMillis', async () => {
      const originalFunc = networkingLib.exponentialBackoff
      networkingLib.exponentialBackoff = jest.fn().mockResolvedValue(wrapInFetchError(500))
      fakeTVMInput.cacheFile = false
      const tvmClient = await TvmClient.init(fakeTVMInput)
      await expect(tvmClient.getAzureBlobCredentials.bind(tvmClient)).toThrowStatusError(500)
      expect(networkingLib.exponentialBackoff).toHaveBeenCalledTimes(1)
      expect(networkingLib.exponentialBackoff).toHaveBeenCalledWith(TvmClient.DefaultApiHost + '/' + TvmClient.AzureBlobEndpoint + '/' + fakeTVMInput.ow.namespace, expect.objectContaining({ headers: { Authorization: 'fakeauth' } }), {})
      expect(fs.readFile).toHaveBeenCalledTimes(0)
      expect(fs.writeFile).toHaveBeenCalledTimes(0)
      expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining(fakeTVMInput.ow.namespace))
      expect(mockLogError).toHaveBeenCalledWith(expect.not.stringContaining(fakeTVMInput.ow.auth))
      networkingLib.exponentialBackoff = originalFunc
    })
    test('when tvm response has a server error with 2 maxRetries', async () => {
      const originalFunc = networkingLib.exponentialBackoff
      networkingLib.exponentialBackoff = jest.fn().mockResolvedValue(wrapInFetchError(500))
      fakeTVMInput.cacheFile = false
      const customInput = fakeTVMInput
      customInput.retryOptions = { maxRetries: 2 }
      const tvmClient = await TvmClient.init(customInput)
      await expect(tvmClient.getAzureBlobCredentials.bind(tvmClient)).toThrowStatusError(500)
      expect(networkingLib.exponentialBackoff).toHaveBeenCalledTimes(1)
      expect(networkingLib.exponentialBackoff).toHaveBeenCalledWith(TvmClient.DefaultApiHost + '/' + TvmClient.AzureBlobEndpoint + '/' + fakeTVMInput.ow.namespace, expect.objectContaining({ headers: { Authorization: 'fakeauth' } }), { maxRetries: 2 })
      expect(fs.readFile).toHaveBeenCalledTimes(0)
      expect(fs.writeFile).toHaveBeenCalledTimes(0)
      expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining(fakeTVMInput.ow.namespace))
      expect(mockLogError).toHaveBeenCalledWith(expect.not.stringContaining(fakeTVMInput.ow.auth))
      networkingLib.exponentialBackoff = originalFunc
    })
    test('when tvm response has a server error with 50ms retryMultiplier', async () => {
      const originalFunc = networkingLib.exponentialBackoff
      networkingLib.exponentialBackoff = jest.fn().mockResolvedValue(wrapInFetchError(500))
      fakeTVMInput.cacheFile = false
      const customInput = fakeTVMInput
      customInput.retryOptions = { initialDelayInMillis: 50 }
      const tvmClient = await TvmClient.init(customInput)
      await expect(tvmClient.getAzureBlobCredentials.bind(tvmClient)).toThrowStatusError(500)
      expect(networkingLib.exponentialBackoff).toHaveBeenCalledTimes(1)
      expect(networkingLib.exponentialBackoff).toHaveBeenCalledWith(TvmClient.DefaultApiHost + '/' + TvmClient.AzureBlobEndpoint + '/' + fakeTVMInput.ow.namespace, expect.objectContaining({ headers: { Authorization: 'fakeauth' } }), { initialDelayInMillis: 50 })
      expect(fs.readFile).toHaveBeenCalledTimes(0)
      expect(fs.writeFile).toHaveBeenCalledTimes(0)
      expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining(fakeTVMInput.ow.namespace))
      expect(mockLogError).toHaveBeenCalledWith(expect.not.stringContaining(fakeTVMInput.ow.auth))
      networkingLib.exponentialBackoff = originalFunc
    })
    test('when tvm fetch is unauthorized', async () => {
      // fake the fetch to the TVM
      fetch.mockResolvedValue(wrapInFetchError(401))
      fakeTVMInput.cacheFile = false
      const tvmClient = await TvmClient.init(fakeTVMInput)
      await expect(tvmClient.getAzureBlobCredentials.bind(tvmClient)).toThrowStatusError(401)
      expect(fs.readFile).toHaveBeenCalledTimes(0)
      expect(fs.writeFile).toHaveBeenCalledTimes(0)
      expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining(fakeTVMInput.ow.namespace))
      expect(mockLogError).toHaveBeenCalledWith(expect.not.stringContaining(fakeTVMInput.ow.auth))
    })
  })
  describe('with caching to file', () => {
    test('when default cache file exists (when cacheFile=undefined)', async () => {
      fetch.mockResolvedValue(wrapInFetchResponse({ bad: 'response' }))
      fs.readFile.mockResolvedValue(Buffer.from(cacheContent))

      const tvmClient = await TvmClient.init(fakeTVMInput)
      const creds = await tvmClient.getAzureBlobCredentials()

      expect(creds).toEqual(fakeAzureTVMResponse)
      expect(fs.readFile).toHaveBeenCalledWith(TvmClient.DefaultTVMCacheFile)
      expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(readCacheLog))
    })
    test('when specified cache file exists', async () => {
      fetch.mockResolvedValue(wrapInFetchResponse({ bad: 'response' }))
      fs.readFile.mockResolvedValue(Buffer.from(cacheContent))
      fakeTVMInput.cacheFile = '/cache'
      const tvmClient = await TvmClient.init(fakeTVMInput)
      const creds = await tvmClient.getAzureBlobCredentials()

      expect(creds).toEqual(fakeAzureTVMResponse)
      expect(fs.readFile).toHaveBeenCalledWith(fakeTVMInput.cacheFile)
      expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(readCacheLog))
    })

    test('when cache is empty', async () => {
      fetch.mockResolvedValue(wrapInFetchResponse(fakeAzureTVMResponse))
      fs.readFile.mockRejectedValue(new Error('should be catched'))

      fakeTVMInput.cacheFile = '/cache'
      const tvmClient = await TvmClient.init(fakeTVMInput)
      const creds = await tvmClient.getAzureBlobCredentials()

      expect(creds).toEqual(fakeAzureTVMResponse)
      expect(fs.writeFile).toHaveBeenCalledWith(fakeTVMInput.cacheFile, cacheContent)
      expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(writeCacheLog))
    })

    test('when cache for other key exists', async () => {
      const prevObject = { prevKey: { fake: 'creds' } }
      fetch.mockResolvedValue(wrapInFetchResponse(fakeAzureTVMResponse))
      fs.readFile.mockResolvedValue(Buffer.from(JSON.stringify(prevObject)))

      const tvmClient = await TvmClient.init(fakeTVMInput)
      const creds = await tvmClient.getAzureBlobCredentials()

      expect(creds).toEqual(fakeAzureTVMResponse)
      expect(fs.writeFile).toHaveBeenCalledWith(TvmClient.DefaultTVMCacheFile, JSON.stringify({ ...prevObject, fakeCacheKey: fakeAzureTVMResponse }))
      expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(writeCacheLog))
    })

    test('when cache for same key exists but is expired', async () => {
      const prevObject = { fakeCacheKey: { fake: 'creds', expiration: minDate } }
      fetch.mockResolvedValue(wrapInFetchResponse(fakeAzureTVMResponse))
      fs.readFile.mockResolvedValue(Buffer.from(JSON.stringify(prevObject)))

      const tvmClient = await TvmClient.init(fakeTVMInput)
      const creds = await tvmClient.getAzureBlobCredentials()

      expect(creds).toEqual(fakeAzureTVMResponse)
      expect(fs.writeFile).toHaveBeenCalledWith(TvmClient.DefaultTVMCacheFile, JSON.stringify({ fakeCacheKey: fakeAzureTVMResponse }))
      expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(expiredCacheLog))
      expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(fetchTvmLog))
      expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(writeCacheLog))
    })
  })
})

describe('getAwsS3Credentials', () => {
  // the general tests are same, we test just that the method is defined
  test('without caching when tvm response is valid', async () => {
    // fake the fetch to the TVM
    fetch.mockResolvedValue(wrapInFetchResponse(fakeAwsS3Response))
    fakeTVMInput.cacheFile = false
    const tvmClient = await TvmClient.init(fakeTVMInput)
    const creds = await tvmClient.getAwsS3Credentials()
    expect(creds).toEqual(fakeAwsS3Response)
    expect(fetch.mock.calls[0][0]).toEqual(TvmClient.DefaultApiHost + '/' + TvmClient.AwsS3Endpoint + '/' + fakeTVMInput.ow.namespace)
    expect(fetch.mock.calls[0][1].headers).toEqual(expect.objectContaining({ Authorization: fakeTVMInput.ow.auth }))
  })
})

describe('getAzureCosmosCredentials', () => {
  // the general tests are same, we test just that the method is defined
  test('without caching when tvm response is valid', async () => {
    // fake the fetch to the TVM
    fetch.mockResolvedValue(wrapInFetchResponse(fakeAzureCosmosResponse))
    fakeTVMInput.cacheFile = false
    const tvmClient = await TvmClient.init(fakeTVMInput)
    const creds = await tvmClient.getAzureCosmosCredentials()
    expect(creds).toEqual(fakeAzureCosmosResponse)
    expect(fetch.mock.calls[0][0]).toEqual(TvmClient.DefaultApiHost + '/' + TvmClient.AzureCosmosEndpoint + '/' + fakeTVMInput.ow.namespace)
    expect(fetch.mock.calls[0][1].headers).toEqual(expect.objectContaining({ Authorization: fakeTVMInput.ow.auth }))
  })
})

describe('with in memory caching', () => {
  const readCacheLog = 'read credentials from cache with key'
  const writeCacheLog = 'wrote credentials to cache with key'
  const fetchTvmLog = 'fetched credentials from tvm'
  const expiredCacheLog = 'expired'
  // the general tests are same, we test just that the method is defined
  test('with cacheFile set to false', async () => {
    // fake the fetch to the TVM
    fetch.mockResolvedValue(wrapInFetchResponse(fakeAwsS3Response))
    fakeTVMInput.cacheFile = false
    const tvmClient = await TvmClient.init(fakeTVMInput)
    let creds = await tvmClient.getAwsS3Credentials()
    expect(creds).toEqual({ ...fakeAwsS3Response })

    TvmClient.inMemoryCache.fakeCacheKey.returnedFrom = 'var'
    creds = await tvmClient.getAwsS3Credentials()
    expect(creds).toEqual({ ...fakeAwsS3Response, returnedFrom: 'var' })
    expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(readCacheLog))
  })

  test('when other cachekey exists', async () => {
    // fake the fetch to the TVM
    fetch.mockResolvedValue(wrapInFetchResponse(fakeAwsS3Response))
    fakeTVMInput.cacheFile = false
    const tvmClient = await TvmClient.init(fakeTVMInput)

    TvmClient.inMemoryCache = { otherCacheKey: fakeAwsS3Response }
    const creds = await tvmClient.getAwsS3Credentials()
    expect(creds).toEqual({ ...fakeAwsS3Response })
    expect(TvmClient.inMemoryCache).toEqual({ otherCacheKey: fakeAwsS3Response, fakeCacheKey: fakeAwsS3Response })
  })

  test('when creds have expired', async () => {
    // fake the fetch to the TVM
    fetch.mockResolvedValue(wrapInFetchResponse(fakeAwsS3Response))
    fakeTVMInput.cacheFile = false
    const tvmClient = await TvmClient.init(fakeTVMInput)

    TvmClient.inMemoryCache = { fakeCacheKey: fakeAwsS3Response }
    TvmClient.inMemoryCache.fakeCacheKey.expiration = new Date().toISOString()
    TvmClient.inMemoryCache.fakeCacheKey.returnedFrom = 'var'

    const creds = await tvmClient.getAwsS3Credentials()
    expect(creds).toEqual({ ...fakeAwsS3Response })
    expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(expiredCacheLog))
    expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(fetchTvmLog))
    expect(mockLogDebug).toHaveBeenCalledWith(expect.stringContaining(writeCacheLog))
  })
})
