async function setupPlugin({ config, global }) {
    let bitbucketBase64AuthToken

    if (config.bitbucketUsername && config.bitbucketToken) {
        bitbucketBase64AuthToken = Buffer.from(`${config.bitbucketUsername}:${config.bitbucketToken}`).toString(
            'base64'
        )
    } else if (config.bitbucketUsername || config.bitbucketToken) {
        throw new Error(
            'Please supply both a Bitbucket username and a personal token to use this plugin with private repos'
        )
    }

    global.bitbucketAuthHeader = bitbucketBase64AuthToken
        ? {
              headers: {
                  Authorization: `Basic ${bitbucketBase64AuthToken}`
              }
          }
        : {}

    global.posthogOptions = {
        headers: {
            Authorization: `Bearer ${config.posthogApiKey}`
        }
    }

    config.posthogHost = config.posthogHost.replace(/\/$/, '')
    config.bitbucketHost = config.bitbucketHost.replace(/\/$/, '')

    global.posthogHost = config.posthogHost.includes('http') ? config.posthogHost : 'https://' + config.posthogHost

    global.bitbucketApiBaseUrl =
        (config.bitbucketHost.includes('http') ? config.bitbucketHost : 'https://' + config.bitbucketHost) +
        `/api/2.0/repositories/${config.bitbucketWorkspace}/${config.repoName}`

    try {
        const posthogRes = await fetchWithRetry(`${global.posthogHost}/api/user`, global.posthogOptions)
        if (posthogRes.status !== 200) {
            throw new Error('Invalid PostHog Personal API key')
        }

        const bitbucketRes = await fetchWithRetry(global.bitbucketApiBaseUrl, global.bitbucketAuthHeader)
        if (bitbucketRes.status !== 200) {
            throw new Error('Unable to connect to Bitbucket - Invalid Bitbucket host, workspace, repo name, or token')
        }
    } catch {
        throw new Error('Unable to connect to APIs')
    }
}

async function runEveryMinute({ config, global }) {
    const annotationsResponse = await fetchWithRetry(
        `${global.posthogHost}/api/annotation/?scope=organization&deleted=false`,
        global.posthogOptions
    )

    const annotationsJson = await annotationsResponse.json()
    let annotations = new Set(annotationsJson.results.map((annotation) => annotation.content))

    const bitbucketTagsResponse = await fetchWithRetry(
        `${global.bitbucketApiBaseUrl}/refs/tags`,
        global.bitbucketAuthHeader
    )

    const bitbucketTagsJson = await bitbucketTagsResponse.json()

    const newTags = bitbucketTagsJson.values
        .map((tag) => ({
            name: tag.name,
            date: tag.target.date
        }))
        .filter((tag) => !annotations.has(tag.name))

    for (let tag of newTags) {
        const createAnnotationRes = await fetchWithRetry(
            `${global.posthogHost}/api/annotation/`,
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.posthogApiKey}`
                },
                body: JSON.stringify({
                    content: tag.name,
                    scope: 'organization',
                    date_marker: tag.date
                })
            },
            'POST'
        )

        if (createAnnotationRes.status === 201) {
            posthog.capture('created_tag_annotation', { tag: tag.name })
        }
    }
}

async function fetchWithRetry(url, options = {}, method = 'GET', isRetry = false) {
    try {
        const res = await fetch(url, { method: method, ...options })
        return res
    } catch {
        if (isRetry) {
            throw new Error(`${method} request to ${url} failed.`)
        }
        const res = await fetchWithRetry(url, options, (method = method), (isRetry = true))
        return res
    }
}
