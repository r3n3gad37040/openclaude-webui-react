(function () {
  'use strict'

  // The bundled UI's media renderer (Fm component) only branches video vs image —
  // any other media_type (e.g. "audio") falls into the image branch and tries to
  // render <img src=foo.mp3>, which 404s and shows "Image failed to load".
  //
  // Runtime workaround: watch the DOM for <img> elements pointing at audio
  // files, hide the React-owned wrapper, and insert an <audio controls> bubble
  // as a sibling. The shim must survive React reconciliation — when the bundle
  // re-fetches the session after `done` and re-mounts the message, a fresh
  // <img> appears and we have to rewrite it again. We use idempotent rewrites
  // keyed by the audio URL plus a periodic safety-net scan.

  var AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|aac|flac|opus)(\?|$|#)/i

  function isAudioUrl(rawUrl) {
    if (!rawUrl) return false
    var url = rawUrl
    // /api/media/serve?path=/abs/path.mp3 — extension lives in the query string
    if (url.indexOf('/api/media/serve') !== -1) {
      try { url = decodeURIComponent(url) } catch (_) { /* keep raw */ }
    }
    return AUDIO_EXT_RE.test(url)
  }

  function buildAudioBubble(src, alt) {
    var bubble = document.createElement('div')
    bubble.className = 'oc-audio-bubble my-3'
    bubble.dataset.ocAudioFor = src
    bubble.style.cssText = [
      'padding: 0.75rem 1rem',
      'border-radius: 0.75rem',
      'border: 1px solid var(--color-border)',
      'background: var(--color-surface)',
      'display: flex',
      'flex-direction: column',
      'gap: 0.5rem',
      'max-width: 520px',
    ].join(';')

    var label = document.createElement('div')
    label.textContent = alt || 'Generated audio'
    label.style.cssText = 'font-size:11px;color:var(--color-muted);letter-spacing:0.02em'
    bubble.appendChild(label)

    var audio = document.createElement('audio')
    audio.controls = true
    audio.preload = 'metadata'
    audio.src = src
    audio.style.cssText = 'width:100%;display:block'
    bubble.appendChild(audio)

    return bubble
  }

  // Idempotent: ensure the wrapper containing this <img> is hidden and that an
  // audio bubble exists immediately after it. Safe to call repeatedly on the
  // same element — only mutates DOM when state needs to change.
  function ensureBubbleFor(img) {
    if (!img) return
    var src = img.currentSrc || img.src || img.dataset.ocAudioSrc || ''
    if (!isAudioUrl(src)) return

    var wrapper = img.closest('div.my-3') || img.parentElement
    if (!wrapper || !wrapper.parentNode) return

    // Look for an existing bubble bound to this URL among the wrapper's siblings.
    var existing = wrapper.parentNode.querySelector(
      ':scope > div.oc-audio-bubble[data-oc-audio-for="' + CSS.escape(src) + '"]'
    )

    if (existing && wrapper.style.display === 'none' && img.dataset.ocAudioRewritten === '1') {
      return  // already in the right state
    }

    // Cache the URL on the img so future scans can recover it even if React
    // momentarily clears src during reconciliation.
    img.dataset.ocAudioSrc = src
    img.dataset.ocAudioRewritten = '1'
    if (img.getAttribute('src')) img.removeAttribute('src')
    if (img.getAttribute('srcset')) img.removeAttribute('srcset')
    wrapper.style.display = 'none'

    if (!existing) {
      var bubble = buildAudioBubble(src, img.alt || '')
      wrapper.parentNode.insertBefore(bubble, wrapper.nextSibling)
    }
  }

  function scanAll() {
    var imgs = document.querySelectorAll('img')
    for (var i = 0; i < imgs.length; i++) ensureBubbleFor(imgs[i])
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return
    var imgs = root.querySelectorAll('img')
    for (var i = 0; i < imgs.length; i++) ensureBubbleFor(imgs[i])
  }

  // ── Tool indicator timer ────────────────────────────────────────────────
  // The bundle's tool indicator (vm component) renders the tool name in a
  // <span class="font-mono font-medium ..."> with a sibling <span> holding
  // "running…" while isLive. We append " M:SS" to the name while running, so
  // long media generations (music up to ~5min) don't look stalled. When the
  // tool transitions to done, the timer freezes at the final value.
  var GEN_TEXT_RE = /^(.*?Generating\s+\S+?)(\s+\d+:\d{2})?\s*$/
  var startTimes = new WeakMap()

  function tickToolIndicator(span) {
    var text = span.textContent || ''
    var m = text.match(GEN_TEXT_RE)
    if (!m) return
    var base = m[1]

    var btn = span.closest('button')
    var running = btn && btn.querySelector('span.text-amber-400')
    var live = running && (running.textContent || '').indexOf('running') !== -1

    if (!live) {
      // Tool finished — freeze whatever time we last wrote and stop ticking.
      startTimes.delete(span)
      return
    }

    if (!startTimes.has(span)) startTimes.set(span, Date.now())
    var elapsed = Math.floor((Date.now() - startTimes.get(span)) / 1000)
    var mins = Math.floor(elapsed / 60)
    var secs = elapsed % 60
    span.textContent = base + ' ' + mins + ':' + (secs < 10 ? '0' : '') + secs
  }

  function scanToolIndicators() {
    var spans = document.querySelectorAll('span.font-mono')
    for (var i = 0; i < spans.length; i++) tickToolIndicator(spans[i])
  }

  function start() {
    scanAll()

    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i]
        if (m.type === 'attributes' && m.target && m.target.tagName === 'IMG') {
          ensureBubbleFor(m.target)
          continue
        }
        var added = m.addedNodes
        for (var j = 0; j < added.length; j++) {
          var n = added[j]
          if (n.nodeType !== 1) continue
          if (n.tagName === 'IMG') ensureBubbleFor(n)
          else scan(n)
        }
      }
    })
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    })

    // Safety net: React's onError can fire synchronously enough on localhost
    // that the bundle transitions to its broken-image error UI before our
    // microtask MutationObserver callback runs. A periodic full-document scan
    // catches any audio <img> that slipped through, including post-`done`
    // session refetches that re-mount the message tree. The same interval
    // ticks the live tool indicator timer (~1Hz visual update at 500ms).
    setInterval(function () {
      scanAll()
      scanToolIndicators()
    }, 500)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
