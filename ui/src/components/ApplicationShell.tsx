import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { useSidebar } from "../context/SidebarContext";
import { pinDocumentScrollToZero } from "../lib/pin-document-scroll";
import { cn } from "../lib/utils";
import { SecondarySidebar } from "./SecondarySidebar";
import { SidebarShell } from "./SidebarShell";

export type ApplicationShellProps = {
  primarySidebar: ReactNode;
  primarySidebarFooter?: ReactNode;
  secondarySidebar?: ReactNode;
  forcePrimarySidebarCollapsed?: boolean;
  banners?: ReactNode;
  header?: ReactNode;
  trailingPane?: ReactNode;
  mobileNavigation?: (visible: boolean) => ReactNode;
  sidebarStorageKey?: string;
  mainRef?: Ref<HTMLElement>;
  mainClassName?: string;
  mainProps?: Omit<ComponentPropsWithoutRef<"main">, "children" | "className" | "id">;
  children: ReactNode;
};

export function ApplicationShell({
  primarySidebar,
  primarySidebarFooter,
  secondarySidebar,
  forcePrimarySidebarCollapsed = false,
  banners,
  header,
  trailingPane,
  mobileNavigation,
  sidebarStorageKey,
  mainRef,
  mainClassName,
  mainProps,
  children,
}: ApplicationShellProps) {
  const {
    sidebarOpen,
    setSidebarOpen,
    collapsed,
    peeking,
    setPeeking,
    isMobile,
    setForceCollapsed,
  } = useSidebar();
  const lastMainScrollTop = useRef(0);
  const [mobileNavVisible, setMobileNavVisible] = useState(true);

  const peekTimer = useRef<number | null>(null);
  const pointerInsidePanel = useRef(false);
  const suppressPeekRef = useRef(false);
  const clearPeekTimer = useCallback(() => {
    if (peekTimer.current !== null) {
      window.clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
  }, []);
  const openPeek = useCallback(() => {
    clearPeekTimer();
    peekTimer.current = window.setTimeout(() => setPeeking(true), 50);
  }, [clearPeekTimer, setPeeking]);
  const openPeekImmediate = useCallback(() => {
    clearPeekTimer();
    setPeeking(true);
  }, [clearPeekTimer, setPeeking]);
  const closePeek = useCallback(() => {
    clearPeekTimer();
    peekTimer.current = window.setTimeout(() => setPeeking(false), 120);
  }, [clearPeekTimer, setPeeking]);
  const handlePanelPointerEnter = useCallback(() => {
    pointerInsidePanel.current = true;
    if (collapsed && !suppressPeekRef.current) openPeek();
  }, [collapsed, openPeek]);
  const handlePanelPointerLeave = useCallback(() => {
    pointerInsidePanel.current = false;
    suppressPeekRef.current = false;
    closePeek();
  }, [closePeek]);
  const handlePanelFocus = useCallback(() => {
    if (!suppressPeekRef.current) openPeekImmediate();
  }, [openPeekImmediate]);
  const handlePanelBlur = useCallback(() => {
    if (!pointerInsidePanel.current) closePeek();
  }, [closePeek]);

  useEffect(() => clearPeekTimer, [clearPeekTimer]);

  const wasCollapsed = useRef(collapsed);
  useEffect(() => {
    if (collapsed === wasCollapsed.current) return;
    if (collapsed) {
      clearPeekTimer();
      setPeeking(false);
      suppressPeekRef.current = pointerInsidePanel.current;
    } else {
      suppressPeekRef.current = false;
    }
    wasCollapsed.current = collapsed;
  }, [collapsed, clearPeekTimer, setPeeking]);

  useEffect(() => {
    if (!peeking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearPeekTimer();
        setPeeking(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearPeekTimer, peeking, setPeeking]);

  const forceRailCollapsed = secondarySidebar != null || forcePrimarySidebarCollapsed;
  useLayoutEffect(() => {
    setForceCollapsed(forceRailCollapsed);
    return () => setForceCollapsed(false);
  }, [forceRailCollapsed, setForceCollapsed]);

  useEffect(() => {
    if (!isMobile) return;

    const edgeZone = 30;
    const minimumDistance = 50;
    const maximumVerticalDrift = 75;
    let startX = 0;
    let startY = 0;

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0]!;
      startX = touch.clientX;
      startY = touch.clientY;
    };
    const onTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0]!;
      const deltaX = touch.clientX - startX;
      if (Math.abs(touch.clientY - startY) > maximumVerticalDrift) return;
      if (!sidebarOpen && startX < edgeZone && deltaX > minimumDistance) {
        setSidebarOpen(true);
      } else if (sidebarOpen && deltaX < -minimumDistance) {
        setSidebarOpen(false);
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [isMobile, setSidebarOpen, sidebarOpen]);

  const updateMobileNavVisibility = useCallback((currentTop: number) => {
    const delta = currentTop - lastMainScrollTop.current;
    if (currentTop <= 24) setMobileNavVisible(true);
    else if (delta > 8) setMobileNavVisible(false);
    else if (delta < -8) setMobileNavVisible(true);
    lastMainScrollTop.current = currentTop;
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setMobileNavVisible(true);
      lastMainScrollTop.current = 0;
      return;
    }

    const onScroll = () => {
      updateMobileNavVisibility(window.scrollY || document.documentElement.scrollTop || 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isMobile, updateMobileNavVisibility]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = isMobile ? "visible" : "clip";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile]);

  useEffect(() => {
    if (isMobile) return;
    return pinDocumentScrollToZero();
  }, [isMobile]);

  const mainStyle = isMobile
    ? ({
        ...mainProps?.style,
        "--tc-composer-bottom": mobileNavVisible
          ? "var(--sz-calc-14)"
          : "var(--sz-calc-8)",
      } as CSSProperties)
    : mainProps?.style;
  const mobileSidebar = secondarySidebar ?? primarySidebar;

  return (
    <div
      className={cn(
        "bg-background text-foreground pt-(--sz-safe-top)",
        isMobile ? "min-h-dvh overflow-x-clip" : "flex h-dvh flex-col overflow-clip",
      )}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-(--z-200) focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Skip to Main Content
      </a>
      {banners}
      <div className={cn("min-h-0 flex-1", isMobile ? "w-full" : "flex overflow-clip")}>
        {isMobile && sidebarOpen ? (
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          />
        ) : null}

        {isMobile ? (
          <div
            className={cn(
              "fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden pt-(--sz-safe-top) transition-transform duration-100 ease-out",
              sidebarOpen ? "translate-x-0" : "-translate-x-full",
            )}
          >
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <div className="w-60 shrink-0 overflow-hidden">{mobileSidebar}</div>
            </div>
            {primarySidebarFooter}
          </div>
        ) : (
          <SidebarShell
            open={sidebarOpen}
            collapsed={collapsed}
            peeking={peeking}
            resizable
            storageKey={sidebarStorageKey}
            onPanelMouseEnter={handlePanelPointerEnter}
            onPanelMouseLeave={handlePanelPointerLeave}
            onPanelFocusCapture={collapsed ? handlePanelFocus : undefined}
            onPanelBlurCapture={collapsed ? handlePanelBlur : undefined}
          >
            <div className="flex min-h-0 flex-1">{primarySidebar}</div>
            {primarySidebarFooter}
          </SidebarShell>
        )}

        {!isMobile && secondarySidebar ? (
          <SecondarySidebar>{secondarySidebar}</SecondarySidebar>
        ) : null}

        <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "h-full flex-1")}>
          <div
            className={cn(
              isMobile &&
                "sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85",
            )}
          >
            {header}
          </div>
          <div className={cn(isMobile ? "block" : "flex min-h-0 flex-1")}>
            <main
              {...mainProps}
              id="main-content"
              ref={mainRef}
              tabIndex={mainProps?.tabIndex ?? -1}
              style={mainStyle}
              className={cn(
                "flex-1 p-4 outline-none md:p-6",
                isMobile
                  ? "overflow-visible pb-(--sz-calc-14)"
                  : "overflow-auto [scrollbar-gutter:stable]",
                mainClassName,
              )}
            >
              {children}
            </main>
            {trailingPane}
          </div>
        </div>
      </div>
      {isMobile ? mobileNavigation?.(mobileNavVisible) : null}
    </div>
  );
}
