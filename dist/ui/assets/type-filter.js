(function () {
  'use strict'

  // ── CSS overrides for inline media (image/video) ─────────────────────────
  // The bundle wraps media in containers with rounded-xl + border + bg
  // letterbox. Strip the visual padding so the media shows borderless.
  var style = document.createElement('style')
  style.textContent = [
    '/* video container — has bg-black/30 letterbox */',
    'div:has(> video[controls]) {',
    '  background: transparent !important;',
    '  border-color: transparent !important;',
    '  border-radius: 6px !important;',
    '  margin: 4px 0 !important;',
    '}',
    '/* image container — wrapper around <img> */',
    'div:has(> img[alt^="Generated"]) {',
    '  background: transparent !important;',
    '  border-color: transparent !important;',
    '  border-radius: 6px !important;',
    '  margin: 0 !important;',
    '}',
  ].join('\n')
  ;(document.head || document.documentElement).appendChild(style)

  // alias/model → type, populated from /api/models
  const modelTypeMap = new Map()

  function inferType(id) {
    const s = (id || '').toLowerCase()
    if (/video|mochi|wan[._-]|kling|cogvideo|animate/.test(s)) return 'video'
    if (/flux|imagen|\bimage\b|imagine|stable[._-]diff|sdxl|hidream|aura|dall[._-]e|wai[._-]nsfw/.test(s)) return 'image'
    // Music checked before audio so overlapping patterns (e.g. elevenlabs-music) hit music
    if (/ace[._-]step|minimax[._-]music|stable[._-]audio|mmaudio|elevenlabs[._-]music|sound[._-]effects/.test(s)) return 'music'
    if (/whisper|orpheus|kokoro|elevenlabs|chatterbox|inworld|[._-]tts[._-]|[._-]tts$|^tts[._-]|speech/.test(s)) return 'audio'
    return 'text'
  }

  // ── Intercept /api/models ────────────────────────────────────────────────
  const origFetch = window.fetch.bind(window)
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input
      : (input instanceof URL ? input.href : (input && input.url) || '')
    const promise = origFetch(input, init)
    if (/\/api\/models(\?|$)/.test(url)) {
      promise.then(function (res) { return res.clone().json() }).then(function (data) {
        if (!data || !Array.isArray(data.models)) return
        for (var m of data.models) {
          var type = m.type || inferType(m.id || '')
          if (m.alias) modelTypeMap.set(m.alias, type)
          if (m.model) modelTypeMap.set(m.model, type)
        }
        filterButtons()
      }).catch(function () {})
    }
    return promise
  }

  // ── State ────────────────────────────────────────────────────────────────
  var activeType = 'all'

  var TYPES = [
    { value: 'all',   label: 'All' },
    { value: 'text',  label: 'Text' },
    { value: 'image', label: 'Image' },
    { value: 'video', label: 'Video' },
    { value: 'audio', label: 'Audio' },
    { value: 'music', label: 'Music' },
  ]

  // ── Filter model list buttons ─────────────────────────────────────────────
  // Model list items have exactly class="truncate" — unique in the bundle.
  function filterButtons() {
    document.querySelectorAll('span').forEach(function (span) {
      if (span.className !== 'truncate') return
      var text = (span.textContent || '').trim()
      if (!text) return
      var btn = span.closest('button')
      if (!btn) return
      if (activeType === 'all') {
        btn.style.display = ''
        return
      }
      if (!modelTypeMap.has(text)) return  // unknown model — leave visible
      btn.style.display = modelTypeMap.get(text) === activeType ? '' : 'none'
    })
  }

  // ── SVG helper ────────────────────────────────────────────────────────────
  function makeSvg(points) {
    var ns = 'http://www.w3.org/2000/svg'
    var svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '14')
    svg.setAttribute('height', '14')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    var poly = document.createElementNS(ns, 'polyline')
    poly.setAttribute('points', points)
    svg.appendChild(poly)
    return svg
  }

  // ── Build custom dropdown ─────────────────────────────────────────────────
  function buildDropdown() {
    var container = document.createElement('div')
    container.id = 'oc-type-filter'
    container.style.cssText = 'position:relative;display:inline-flex;align-items:center'

    var isOpen = false

    // ── Trigger button — matches provider/model button style ────────────────
    var trigger = document.createElement('button')
    trigger.type = 'button'

    function applyTriggerStyle(open) {
      trigger.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:6px',
        'padding:6px 12px',
        'border-radius:8px',
        'border:1px solid ' + (open ? 'var(--color-accent,#6366f1)' : 'var(--color-border,#333)'),
        'background:var(--color-surface,#1a1a1a)',
        'color:var(--color-text,#eee)',
        'font-size:inherit',
        'font-family:inherit',
        'font-weight:500',
        'cursor:pointer',
        'transition:border-color .15s,background .15s',
        'outline:none',
        'white-space:nowrap',
      ].join(';')
    }
    applyTriggerStyle(false)

    var triggerLabel = document.createElement('span')
    triggerLabel.textContent = 'All'
    trigger.appendChild(triggerLabel)

    var chevron = makeSvg('6,9 12,15 18,9')
    chevron.style.cssText = 'flex-shrink:0;transition:transform .15s'
    trigger.appendChild(chevron)

    // ── Dropdown panel ───────────────────────────────────────────────────────
    var panel = document.createElement('div')
    panel.style.cssText = [
      'position:absolute',
      'top:calc(100% + 4px)',
      'left:0',
      'z-index:9999',
      'min-width:140px',
      'border-radius:8px',
      'border:1px solid var(--color-border,#333)',
      'background:var(--color-surface,#1a1a1a)',
      'box-shadow:0 20px 40px rgba(0,0,0,0.5)',
      'padding:4px',
      'display:none',
    ].join(';')

    function setOpen(open) {
      isOpen = open
      panel.style.display = open ? 'block' : 'none'
      applyTriggerStyle(open)
      chevron.style.transform = open ? 'rotate(180deg)' : ''
    }

    // ── Option buttons ───────────────────────────────────────────────────────
    TYPES.forEach(function (t) {
      var btn = document.createElement('button')
      btn.type = 'button'
      btn.dataset.ocValue = t.value

      function applyOptStyle(selected) {
        btn.style.cssText = [
          'display:flex',
          'align-items:center',
          'gap:8px',
          'width:100%',
          'padding:8px 12px',
          'border:none',
          'border-radius:6px',
          'background:transparent',
          'color:' + (selected ? 'var(--color-accent,#6366f1)' : 'var(--color-text,#eee)'),
          'font-size:14px',
          'font-weight:' + (selected ? '500' : 'normal'),
          'font-family:inherit',
          'text-align:left',
          'cursor:pointer',
        ].join(';')
      }
      applyOptStyle(t.value === activeType)

      // Check icon slot
      var checkWrap = document.createElement('span')
      checkWrap.style.cssText = 'width:14px;height:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0'
      if (t.value === activeType) checkWrap.appendChild(makeSvg('4,12 9,17 20,6'))
      btn.appendChild(checkWrap)

      var labelSpan = document.createElement('span')
      labelSpan.textContent = t.label
      btn.appendChild(labelSpan)

      btn.addEventListener('mouseenter', function () {
        btn.style.background = 'var(--color-user-bubble,#2a2a2a)'
      })
      btn.addEventListener('mouseleave', function () {
        btn.style.background = 'transparent'
      })

      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        activeType = t.value
        triggerLabel.textContent = t.label

        // Update all option states
        panel.querySelectorAll('button[data-oc-value]').forEach(function (b) {
          var selected = b.dataset.ocValue === activeType
          var cw = b.querySelector('span')
          cw.innerHTML = ''
          if (selected) cw.appendChild(makeSvg('4,12 9,17 20,6'))
          b.style.color = selected ? 'var(--color-accent,#6366f1)' : 'var(--color-text,#eee)'
          b.style.fontWeight = selected ? '500' : 'normal'
        })

        setOpen(false)
        filterButtons()
      })

      panel.appendChild(btn)
    })

    trigger.addEventListener('click', function (e) {
      e.stopPropagation()
      setOpen(!isOpen)
    })

    document.addEventListener('click', function (e) {
      if (isOpen && !container.contains(e.target)) setOpen(false)
    })

    container.appendChild(trigger)
    container.appendChild(panel)
    return container
  }

  // ── Inject into header ───────────────────────────────────────────────────
  // Header: [ProviderPicker] <span class="text-[var(--color-muted)]">/</span> [ModelPicker]
  // Target: [TypeDropdown] <span "/"> [ProviderPicker] <span "/"> [ModelPicker]
  function tryInject() {
    if (document.getElementById('oc-type-filter')) return

    var spans = document.querySelectorAll('span')
    for (var i = 0; i < spans.length; i++) {
      var span = spans[i]
      if (span.textContent !== '/') continue
      if (!span.className.includes('color-muted')) continue

      var parent = span.parentElement
      if (!parent) continue
      var providerEl = span.previousElementSibling
      if (!providerEl) continue

      var newSep = document.createElement('span')
      newSep.className = span.className
      newSep.textContent = '/'

      var dropdown = buildDropdown()
      parent.insertBefore(newSep, providerEl)
      parent.insertBefore(dropdown, newSep)
      return
    }
  }

  // ── Start observer once body exists ──────────────────────────────────────
  function startObserver() {
    var obs = new MutationObserver(function () {
      tryInject()
      filterButtons()
    })
    obs.observe(document.body, { childList: true, subtree: true })
    tryInject()
  }

  if (document.body) {
    startObserver()
  } else {
    document.addEventListener('DOMContentLoaded', startObserver)
  }
})()
