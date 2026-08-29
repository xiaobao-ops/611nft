import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../', import.meta.url).pathname
const source = (name) => readFileSync(`${root}public/nfttool-runtime/${name}`, 'utf8')

test('Live Mint keeps the restored compact event row contract', () => {
  const monitor = source('mint-monitor.js')
  const styles = source('styles.css')
  for (const marker of ['live-row-top', 'live-row-main', 'live-project-copy', 'select-mint-event', 'data-select-event', 'live-row-meta']) {
    assert.match(monitor, new RegExp(marker))
  }
  assert.match(styles, /\.live-monitor-layout|\.mint-monitor-layout\s*\{[\s\S]*grid-template-columns:/)
  assert.match(styles, /\.live-project-copy\s*\{[\s\S]*background:\s*transparent/)
  assert.match(styles, /@media\s*\(max-width:\s*760px\)[\s\S]*\.mint-monitor-layout\s*\{\s*grid-template-columns:\s*1fr/)
})

test('Live Mint keeps read-only status while its sender profile controls the chain', () => {
  const monitor = source('mint-monitor.js')
  const panel = source('mint-action-panel.js')
  const core = source('core.js')
  assert.doesNotMatch(monitor, /networkBar\(\{ state, includeAsset: false, mode: 'readOnly' \}\)/)
  assert.match(panel, /networkBar\(\{ state, includeAsset: false, mode: 'writeProfile' \}\)/)
  assert.doesNotMatch(monitor, /includeChain|chain-select|<span>Network<\/span>/)
  assert.doesNotMatch(panel, /includeChain|chain-select|<span>Network<\/span>/)
  assert.match(panel, /action-read-only-notice/)
  assert.match(panel, /inner\.bind\?\.\(root\)/)
  assert.match(core, /syncWriteChain\(runtimeState, resolvedChainId\)/)
  assert.match(monitor, /Number\(form\.chainId\) !== Number\(state\.chainId\)/)
  assert.match(monitor, /disposeMonitorForm\(form\)/)
  assert.match(monitor, /chainId: Number\(state\.chainId\)/)
})

test('Live Mint action panel removes duplicate headers and fits the viewport', () => {
  const panel = source('mint-action-panel.js')
  const styles = source('styles.css')
  assert.doesNotMatch(panel, /selectedEventHeader|opensea-quick-header/)
  assert.match(panel, /opensea-quick-direct/)
  assert.match(panel, /api\('\/api\/nft-mint\/preview'/)
  assert.match(panel, /direct/)
  assert.match(panel, /scrollTop: 0/)
  assert.match(panel, /action\.scrollTop = currentPanel\.scrollTop/)
  assert.match(panel, /panel\.scrollTop = action\.scrollTop/)
  assert.match(panel, /action\.scrollTop = panel\.scrollTop/)
  assert.match(styles, /\.mint-action-panel\s*\{[\s\S]*max-height:\s*calc\(100dvh - 82px\)/)
  assert.match(styles, /\.opensea-wallet-panel \.table-scroll\s*\{\s*max-height:\s*180px;/)
  assert.match(styles, /\.opensea-plan-table\s*\{\s*max-height:\s*250px;/)
})

test('single Vite shell keeps the runtime frame stable and preserves redraw context', () => {
  const runtimeRoute = readFileSync(`${root}src/RuntimeRoute.jsx`, 'utf8')
  const shellStyles = readFileSync(`${root}src/shell.css`, 'utf8')
  const core = source('core.js')
  assert.match(runtimeRoute, /src=\{`\/nfttool-runtime\/\$\{route\.moduleName\}`\}/)
  assert.match(runtimeRoute, /key=\{route\.moduleName\}/)
  assert.match(shellStyles, /\.routeFrame[^}]*width:\s*100%;[^}]*height:\s*100%/)
  assert.match(shellStyles, /@media\s*\(max-width:\s*760px\)/)
  assert.match(core, /scrollPositionSnapshot\(root\)/)
  assert.match(core, /restoreScrollPosition\(root, snapshot\)/)
  assert.match(core, /data-scroll-key/)
  assert.match(core, /requestAnimationFrame/)
})

test('wallet tables expose a stable nested scroll identity across redraws', () => {
  const components = source('components.js')
  const core = source('core.js')
  assert.match(components, /data-scroll-key="wallet-table:\$\{escapeHtml\(inputName\)\}"/)
  assert.match(core, /key\.startsWith\('scroll:'\)/)
  assert.match(core, /querySelectorAll\('\[data-scroll-key\]'\)/)
})
