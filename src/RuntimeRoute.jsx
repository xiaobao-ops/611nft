import { useEffect, useRef, useState } from "react"

export default function RuntimeRoute({ route }) {
  const frameRef = useRef(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setLoaded(false)
  }, [route.moduleName])

  return (
    <section className="routeFrame" aria-label={route.label}>
      {!loaded ? <div className="routeLoading" role="status"><span className="shellSpinner" />正在加载 {route.label}</div> : null}
      <iframe
        key={route.moduleName}
        ref={frameRef}
        className={loaded ? "runtimeFrame ready" : "runtimeFrame"}
        src={`/nfttool-runtime/${route.moduleName}`}
        title={route.label}
        onLoad={() => setLoaded(true)}
      />
    </section>
  )
}
