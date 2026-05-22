/**
 * UniParse · 全能视频解析 - Vercel API Route
 * 支持 B站、YouTube、抖音等主流视频平台
 * 部署到 Vercel 后自动生成 API 地址
 */

module.exports = async (req, res) => {
  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'OPTIONS') {
    res.status(200).end()
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: '仅支持 POST 请求' })
    return
  }

  try {
    const { url } = req.body || {}

    if (!url) {
      res.status(400).json({ error: '缺少 url 参数' })
      return
    }

    const platform = detectPlatform(url)
    if (!platform) {
      res.status(400).json({ error: '不支持的视频平台，请检查链接是否正确' })
      return
    }

    let result
    switch (platform) {
      case 'bilibili':
        result = await parseBilibili(url)
        break
      case 'youtube':
        result = await parseYouTube(url)
        break
      case 'tiktok':
        result = await parseTikTok(url)
        break
      default:
        res.status(400).json({ error: `暂不支持 ${platform} 平台` })
        return
    }

    res.json(result)
  } catch (err) {
    console.error('Parse error:', err)
    res.status(500).json({ error: '解析失败: ' + err.message })
  }
}

// ═══════════════════════════════════════════════════════════
// 平台识别
// ═══════════════════════════════════════════════════════════

function detectPlatform(url) {
  const lower = url.toLowerCase()
  if (lower.includes('bilibili.com')) return 'bilibili'
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube'
  if (lower.includes('tiktok.com') || lower.includes('douyin.com')) return 'tiktok'
  if (lower.includes('v.qq.com')) return 'qq'
  if (lower.includes('iqiyi.com')) return 'iqiyi'
  if (lower.includes('youku.com')) return 'youku'
  if (lower.includes('kuaishou.com') || lower.includes('ksurl')) return 'kuaishou'
  if (lower.includes('ixigua.com')) return 'xigua'
  if (lower.includes('twitter.com') || lower.includes('x.com')) return 'twitter'
  if (lower.includes('instagram.com')) return 'instagram'
  return null
}

// ═══════════════════════════════════════════════════════════
// B站解析
// ═══════════════════════════════════════════════════════════

async function parseBilibili(url) {
  const bvMatch = url.match(/BV\w{10}/i)
  if (!bvMatch) {
    return { error: '无法识别 B站视频 ID' }
  }
  const bvid = bvMatch[0].toUpperCase()

  const viewData = await fetchWithRetry(
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
  )

  if (viewData.code !== 0) {
    return { error: '获取视频信息失败: ' + viewData.message }
  }

  const videoInfo = viewData.data
  const cid = videoInfo.cid
  const title = videoInfo.title
  const author = videoInfo.owner?.name || '未知'
  const cover = videoInfo.pic ? (videoInfo.pic.startsWith('http') ? videoInfo.pic : 'https:' + videoInfo.pic) : null
  const duration = formatDuration(videoInfo.duration)

  const wbiKeys = await getWbiKeys()

  const playParams = {
    bvid, cid, qn: 120, fnval: 4048, fnver: 0,
    platform: 'html5', html5: 1, high_quality: 1,
  }

  const { w_rid, wts } = signWbi(playParams, wbiKeys)
  const playUrl = `https://api.bilibili.com/x/player/wbi/playurl?${buildQuery({ ...playParams, w_rid, wts })}`
  const playData = await fetchWithRetry(playUrl)

  const qualities = []
  if (playData.code === 0 && playData.data?.durl) {
    playData.data.durl.forEach((durl, idx) => {
      const qn = durl.quality
      qualities.push({
        id: qn, name: getQnName(qn), resolution: getQnRes(qn),
        url: durl.url, size: formatSize(durl.size), order: idx,
      })
    })
    const seen = new Set()
    const unique = qualities.filter(q => {
      if (seen.has(q.id)) return false
      seen.add(q.id)
      return true
    })
    unique.sort((a, b) => b.id - a.id)
    qualities.length = 0
    qualities.push(...unique)
  }

  const subtitles = []
  try {
    const subUrl = `https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`
    const subData = await fetchWithRetry(subUrl)
    if (subData.code === 0 && subData.data?.subtitle?.subtitles) {
      subData.data.subtitle.subtitles.forEach(sub => {
        subtitles.push({
          lang: sub.lan_doc || sub.lang,
          url: sub.subtitle_url ? (sub.subtitle_url.startsWith('http') ? sub.subtitle_url : 'https:' + sub.subtitle_url) : null,
        })
      })
    }
  } catch (e) {
    // 字幕获取失败不影响主功能
  }

  return {
    success: true, platform: 'bilibili', title, author, duration, cover, bvid, cid,
    subtitles, qualities,
  }
}

// ═══════════════════════════════════════════════════════════
// WBI 签名
// ═══════════════════════════════════════════════════════════

async function getWbiKeys() {
  try {
    const resp = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    })
    const navData = await resp.json()
    if (navData.code === 0 && navData.data?.wbi_img) {
      const imgUrl = navData.data.wbi_img.img_url || ''
      const subUrl = navData.data.wbi_img.sub_url || ''
      const imgKey = imgUrl.match(/([a-f0-9]+)\.png/)?.[1] || ''
      const subKey = subUrl.match(/([a-f0-9]+)\.png/)?.[1] || ''
      if (imgKey && subKey) return { imgKey, subKey }
    }
  } catch (e) {}
  return { imgKey: '7cd084941508a71b4d96f2e3d123ff0c', subKey: '4932caff0ff746eab6f01bf08b70ac45' }
}

function signWbi(params, keys) {
  const mixin = keys.subKey + keys.imgKey
  let mix = ''
  for (let i = 0; i < mixin.length; i += 2) mix += mixin[i]
  for (let i = 1; i < mixin.length; i += 2) mix += mixin[i]
  const mixKey = mix.slice(0, 32)
  const wts = Math.floor(Date.now() / 1000)
  const keys_sorted = Object.keys(params).sort()
  const query = keys_sorted.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&')
  const w_rid = md5(query + mixKey)
  return { w_rid, wts }
}

// ═══════════════════════════════════════════════════════════
// YouTube 解析
// ═══════════════════════════════════════════════════════════

async function parseYouTube(url) {
  let videoId
  const ytMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)
  if (ytMatch) {
    videoId = ytMatch[1]
  } else {
    const m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
    if (!m) return { error: '无法识别 YouTube 视频 ID' }
    videoId = m[1]
  }

  const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoId,
      context: { client: { clientName: 'WEB', clientVersion: '2.20210622.10.00' } },
    }),
  })

  const data = await response.json()
  if (!data.streamingData) {
    return { error: '无法获取视频流，可能视频不可用' }
  }

  const sd = data.streamingData
  const details = data.videoDetails || {}

  const qualities = []
  const seenRes = new Set()

  const addFormats = (formats) => {
    formats?.forEach(f => {
      const res = f.audioBitrate ? 'Audio' : (f.qualityLabel || f.quality || 'Unknown')
      const key = res + (f.audioBitrate || '')
      if (seenRes.has(key)) return
      seenRes.add(key)
      qualities.push({
        id: f.itag || res, name: f.qualityLabel || f.quality || res,
        resolution: f.qualityLabel || null, url: f.url || null,
        size: null, order: qualities.length,
      })
    })
  }

  addFormats(sd.formats)
  addFormats(sd.adaptiveFormats)

  qualities.sort((a, b) => {
    const ra = parseInt(a.resolution) || 0
    const rb = parseInt(b.resolution) || 0
    return rb - ra
  })

  return {
    success: true, platform: 'youtube',
    title: details.title || 'YouTube 视频',
    author: details.author || 'Unknown',
    duration: formatDuration(parseInt(details.lengthSeconds) || 0),
    cover: details.thumbnail?.thumbnails?.[0]?.url || null,
    subtitles: [], qualities,
  }
}

// ═══════════════════════════════════════════════════════════
// TikTok 解析
// ═══════════════════════════════════════════════════════════

async function parseTikTok(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    const html = await resp.text()

    const ogMatch = html.match(/<meta property="og:title" content="([^"]+)"/)
    const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/)
    const videoMatch = html.match(/<meta property="og:video" content="([^"]+)"/)

    if (!videoMatch) {
      return { error: '无法解析 TikTok 视频，可能需要登录' }
    }

    const title = ogMatch ? ogMatch[1] : 'TikTok 视频'
    const author = descMatch ? descMatch[1].split('@')[1]?.split(' ')[0] : 'TikTok 用户'

    return {
      success: true, platform: 'tiktok', title, author,
      duration: null, cover: null, subtitles: [],
      qualities: [{ id: 'default', name: '原画', resolution: 'Best', url: videoMatch[1], size: null, order: 0 }],
    }
  } catch (e) {
    return { error: 'TikTok 解析失败: ' + e.message }
  }
}

// ═══════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════

async function fetchWithRetry(url, retries = 2) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com/',
    },
  })
  if (!resp.ok && retries > 0) {
    await new Promise(r => setTimeout(r, 500))
    return fetchWithRetry(url, retries - 1)
  }
  return resp.json()
}

function buildQuery(params) {
  return Object.keys(params).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&')
}

function md5(str) {
  function rotl(x, n) { return (x << n) | (x >>> (32 - n)) }
  function toHex(n) {
    let s = ''
    for (let i = 0; i < 4; i++) {
      s += '0123456789abcdef'[(n >> (i * 8 + 4)) & 15]
      s += '0123456789abcdef'[(n >> (i * 8)) & 15]
    }
    return s
  }
  function addUnsigned(x, y) {
    const l = (x & 0xffff) + (y & 0xffff)
    return (((x >>> 16) + (y >>> 16) + (l >>> 16)) << 16) | (l & 0xffff)
  }
  const bytes = []
  for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff)
  const bitLen = bytes.length * 8
  bytes.push(0x80)
  while ((bytes.length % 64) !== 56) bytes.push(0)
  for (let i = 0; i < 8; i++) bytes.push((bitLen >>> (i * 8)) & 0xff)
  const words = []
  for (let i = 0; i < bytes.length; i += 4) {
    words.push(bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24))
  }
  const K = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21]
  const T = []
  for (let i = 1; i <= 64; i++) T.push(Math.floor(Math.abs(Math.sin(i)) * 0x100000000))
  let [a, b, c, d] = K
  for (let i = 0; i < words.length; i += 16) {
    const X = words.slice(i, i + 16)
    let [A, B, C, D] = [a, b, c, d]
    for (let j = 0; j < 64; j++) {
      let F, g
      if (j < 16) { F = (B & C) | ((~B) & D); g = j }
      else if (j < 32) { F = (D & B) | ((~D) & C); g = (5 * j + 1) % 16 }
      else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16 }
      else { F = C ^ (B | (~D)); g = (7 * j) % 16 }
      F = addUnsigned(addUnsigned(addUnsigned(A, F), addUnsigned(T[j], X[g])), 0)
      F = addUnsigned(rotl(F, S[j]), B)
      ;[A, B, C, D] = [D, F, B, C]
    }
    a = addUnsigned(a, A); b = addUnsigned(b, B); c = addUnsigned(c, C); d = addUnsigned(d, D)
  }
  return toHex(a) + toHex(b) + toHex(c) + toHex(d)
}

function formatDuration(seconds) {
  if (!seconds) return null
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatSize(bytes) {
  if (!bytes) return null
  if (bytes > 1073741824) return (bytes / 1073741824).toFixed(1) + 'GB'
  if (bytes > 1048576) return (bytes / 1048576).toFixed(0) + 'MB'
  return (bytes / 1024).toFixed(0) + 'KB'
}

function getQnName(qn) {
  const map = {
    200: '1080P 高码率', 120: '1080P 高清', 116: '1080P+', 112: '1080P',
    80: '1080P', 74: '720P 60帧', 64: '720P 高清',
    32: '480P 清晰', 16: '360P 流畅', 6: '240P 省流',
  }
  return map[qn] || `${qn}P`
}

function getQnRes(qn) {
  const map = {
    200: '1080P', 120: '1080P', 116: '1080P+', 112: '1080P',
    80: '1080P', 74: '720P', 64: '720P', 32: '480P', 16: '360P', 6: '240P',
  }
  return map[qn] || `${qn}P`
}