import {
  Bell,
  ChevronDown,
  Crosshair,
  History,
  ListTree,
  Menu,
  PanelLeftClose,
  Send,
  WalletCards,
  X,
  Zap,
} from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import logoUrl from "./assets/611nft-logo-ui.png"
import { APP_ROUTES, MENU_SECTIONS, menuRoutes, resolveRoute } from "./routes.js"
import "./shell.css"

const RuntimeRoute = lazy(() => import("./RuntimeRoute.jsx"))
const AlarmRoute = lazy(() => import("./AlarmRoute.jsx"))
const TransactionsRoute = lazy(() => import("./TransactionsRoute.jsx"))

const pageRoutes = {
  alarm: AlarmRoute,
  transactions: TransactionsRoute,
}

const sectionIcons = {
  wallets: WalletCards,
  "mint-monitor": Crosshair,
  "follow-mint": ListTree,
  advanced: Zap,
  "nft-management": Send,
  "wallet-alert": Bell,
  transactions: History,
}

const expandableSections = new Set(["wallets", "advanced", "nft-management"])

function currentLocation() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function useHistoryLocation() {
  const [location, setLocation] = useState(currentLocation)

  useEffect(() => {
    const update = () => setLocation(currentLocation())
    window.addEventListener("popstate", update)
    window.addEventListener("nfttool:navigate", update)
    return () => {
      window.removeEventListener("popstate", update)
      window.removeEventListener("nfttool:navigate", update)
    }
  }, [])

  return location
}

function navigate(path, { replace = false } = {}) {
  const target = new URL(path, window.location.origin)
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  const next = `${target.pathname}${target.search}${target.hash}`
  if (current === next) return
  window.history[replace ? "replaceState" : "pushState"]({}, "", next)
  window.dispatchEvent(new Event("nfttool:navigate"))
}

function RouteLink({ route, active, onNavigate }) {
  return (
    <a
      className={active ? "menuLink active" : "menuLink"}
      href={route.path}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        navigate(route.path)
        onNavigate?.()
      }}
    >
      <span>{route.label}</span>
    </a>
  )
}

function Sidebar({ activeRoute, mobileOpen, setMobileOpen, collapsed, setCollapsed }) {
  const [openGroups, setOpenGroups] = useState(() => new Set(expandableSections))

  const toggleGroup = (sectionId) => {
    setOpenGroups((current) => {
      const next = new Set(current)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  return (
    <>
      <button
        className={mobileOpen ? "sidebarScrim visible" : "sidebarScrim"}
        type="button"
        aria-label="关闭导航"
        onClick={() => setMobileOpen(false)}
      />
      <aside className={`${collapsed ? "toolSidebar collapsed" : "toolSidebar"}${mobileOpen ? " mobileOpen" : ""}`}>
        <div className="shellBrand">
          <img src={logoUrl} alt="NFT TOOL" />
          <div><strong>NFT TOOL</strong><span>钱包与铸造工作台</span></div>
          <button className="mobileClose" type="button" onClick={() => setMobileOpen(false)} aria-label="关闭导航"><X size={19} /></button>
        </div>

        <nav className="toolMenu" aria-label="功能导航">
          {MENU_SECTIONS.map((section) => {
            const routes = menuRoutes(section)
            const Icon = sectionIcons[section.id]
            const expandable = expandableSections.has(section.id)
            const open = !expandable || openGroups.has(section.id)
            const directRoute = !expandable ? routes[0] : null
            const sectionActive = routes.some((route) => route.id === activeRoute?.id)

            if (directRoute) {
              return (
                <a
                  className={sectionActive ? "sectionLink active" : "sectionLink"}
                  href={directRoute.path}
                  key={section.id}
                  aria-current={sectionActive ? "page" : undefined}
                  title={collapsed ? directRoute.label : undefined}
                  onClick={(event) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                    event.preventDefault()
                    navigate(directRoute.path)
                    setMobileOpen(false)
                  }}
                >
                  <Icon size={19} aria-hidden="true" />
                  <span>{directRoute.label}</span>
                </a>
              )
            }

            return (
              <div className={sectionActive ? "menuSection active" : "menuSection"} key={section.id}>
                <button
                  className="sectionButton"
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggleGroup(section.id)}
                  title={collapsed ? section.label : undefined}
                >
                  <Icon size={19} aria-hidden="true" />
                  <span>{section.label}</span>
                  <ChevronDown className={open ? "chevron open" : "chevron"} size={16} aria-hidden="true" />
                </button>
                {open ? <div className="sectionChildren">{routes.map((route) => (
                  <RouteLink key={route.id} route={route} active={route.id === activeRoute?.id} onNavigate={() => setMobileOpen(false)} />
                ))}</div> : null}
              </div>
            )
          })}
        </nav>

        <button className="collapseButton" type="button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "展开导航" : "收起导航"}>
          <PanelLeftClose size={18} />
          <span>{collapsed ? "展开" : "收起导航"}</span>
        </button>
      </aside>
    </>
  )
}

function NotFound() {
  return (
    <section className="notFound">
      <strong>页面不存在</strong>
      <a href={APP_ROUTES[0].path} onClick={(event) => { event.preventDefault(); navigate(APP_ROUTES[0].path) }}>返回钱包管理</a>
    </section>
  )
}

export default function Shell() {
  const location = useHistoryLocation()
  const routeState = useMemo(() => resolveRoute(location), [location])
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    if (!routeState.route || !routeState.redirected) return
    const suffix = `${window.location.search}${window.location.hash}`
    navigate(`${routeState.canonicalPath}${suffix}`, { replace: true })
  }, [routeState.canonicalPath, routeState.redirected, routeState.route])

  const activeRoute = routeState.route
  const PageRoute = activeRoute ? pageRoutes[activeRoute.kind] : null

  return (
    <div className={collapsed ? "toolShell navCollapsed" : "toolShell"}>
      <Sidebar
        activeRoute={activeRoute}
        mobileOpen={mobileOpen}
        setMobileOpen={setMobileOpen}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
      />
      <main className="shellMain">
        <header className="shellHeader">
          <button className="mobileMenuButton" type="button" onClick={() => setMobileOpen(true)} aria-label="打开导航"><Menu size={20} /></button>
          <div><span>NFT TOOL</span><h1>{activeRoute?.label || "页面不存在"}</h1></div>
        </header>
        <div className="routeOutlet">
          <Suspense fallback={<div className="routeLoading" role="status"><span className="shellSpinner" />正在加载</div>}>
            {!activeRoute ? <NotFound /> : activeRoute.kind === "runtime"
              ? <RuntimeRoute route={activeRoute} />
              : PageRoute ? <PageRoute /> : <NotFound />}
          </Suspense>
        </div>
      </main>
    </div>
  )
}
