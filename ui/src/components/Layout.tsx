import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate, useNavigationType, useParams } from "@/lib/router";
import { Sidebar } from "./Sidebar";
import { CompanySettingsSidebar } from "./CompanySettingsSidebar";
import { CompanySettingsNav } from "./access/CompanySettingsNav";
import { AppsSidebar } from "./AppsSidebar";
import { AppDetailSidebar } from "./AppConnectionSidebar";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { PropertiesPanel } from "./PropertiesPanel";
import { CommandPalette } from "./CommandPalette";
import { NewIssueDialog } from "./NewIssueDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { NewGoalDialog } from "./NewGoalDialog";
import { NewAgentDialog } from "./NewAgentDialog";
import { KeyboardShortcutsCheatsheet } from "./KeyboardShortcutsCheatsheet";
import { ToastViewport } from "./ToastViewport";
import { MobileBottomNav } from "./MobileBottomNav";
import { WorktreeBanner } from "./WorktreeBanner";
import { DevRestartBanner } from "./DevRestartBanner";
import { StandaloneBrowserControls } from "./StandaloneBrowserControls";
import { RouteErrorBoundary } from "./RouteErrorBoundary";
import { SidebarAccountMenu } from "./SidebarAccountMenu";
import { ApplicationShell } from "./ApplicationShell";
import { useDialogActions } from "../context/DialogContext";
import { GeneralSettingsProvider } from "../context/GeneralSettingsContext";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useAppsEnabled } from "../hooks/useAppsEnabled";
import { useCompanyPageMemory } from "../hooks/useCompanyPageMemory";
import { healthApi } from "../api/health";
import { instanceSettingsApi } from "../api/instanceSettings";
import { resolveArchivedCompanyBounce, shouldSyncCompanySelectionFromRoute } from "../lib/company-selection";
import { useOptionalToastActions } from "../context/ToastContext";
import {
  applyMainContentScrollTop,
  NavigationScrollMemory,
  resetNavigationScroll,
  shouldResetScrollOnNavigation,
} from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { scheduleMainContentFocus } from "../lib/main-content-focus";
import { NotFoundPage } from "../pages/NotFound";
import { PluginSlotMount, resolveRouteSidebarSlot, usePluginSlots } from "../plugins/slots";

function getCompanyRouteSegment(pathname: string, companyPrefix: string | undefined): string | null {
  return getCompanyPathSegments(pathname, companyPrefix)[0]?.toLowerCase() ?? null;
}

function getCompanyPathSegments(pathname: string, companyPrefix: string | undefined): string[] {
  if (!companyPrefix) return [];
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return [];
  if (segments[0]?.toUpperCase() !== companyPrefix.toUpperCase()) return [];
  return segments.slice(1);
}

const RESERVED_APP_SUBPATHS = new Set([
  "browse",
  "connections",
  "connect",
  "review",
  "attention",
  "gateways",
  "advanced",
  "app",
]);

function isSkillsStoreRoute(pathname: string, companyPrefix: string | undefined) {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0]?.toLowerCase() === "skills") return true;
  if (!companyPrefix) return false;
  return (
    segments[0]?.toUpperCase() === companyPrefix.toUpperCase() &&
    segments[1]?.toLowerCase() === "skills"
  );
}

export function Layout() {
  const {
    toggleSidebar,
    toggleCollapsed,
    isMobile,
  } = useSidebar();
  const { openNewIssue, openOnboarding } = useDialogActions();
  const { togglePanelVisible } = usePanel();
  // Optional: Layout also renders in harnesses without a ToastProvider.
  const pushToast = useOptionalToastActions()?.pushToast ?? null;
  const {
    companies,
    loading: companiesLoading,
    selectedCompany,
    selectedCompanyId,
    selectionSource,
    setSelectedCompanyId,
  } = useCompany();
  const {
    companyPrefix,
    pluginRoutePath: matchedPluginRoutePath,
  } = useParams<{ companyPrefix: string; pluginRoutePath?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const { enabled: appsEnabled } = useAppsEnabled();
  const isCompanySettingsRoute = [
    "/company/settings",
    "/company/export",
    "/company/import",
  ].some((settingsPath) => location.pathname.includes(settingsPath));
  const companyPathSegments = getCompanyPathSegments(location.pathname, companyPrefix);
  const isToolsRoute = companyPathSegments[0]?.toLowerCase() === "tools";
  const isAppsRoute = companyPathSegments[0]?.toLowerCase() === "apps";
  const appDetailConnectionId =
    isAppsRoute && companyPathSegments[1] && !RESERVED_APP_SUBPATHS.has(companyPathSegments[1].toLowerCase())
      ? companyPathSegments[1]
      : null;
  const appDetailApplicationId =
    isAppsRoute && companyPathSegments[1]?.toLowerCase() === "app" && companyPathSegments[2]
      ? companyPathSegments[2]
      : null;
  // The Skills Store renders its own secondary (category) sidebar, so the main
  // app nav collapses to its rail throughout the Skills Store section (PAP-10879).
  const isSkillsRoute = isSkillsStoreRoute(location.pathname, companyPrefix);
  const onboardingTriggered = useRef(false);
  const previousPathname = useRef<string | null>(null);
  const mainContentRef = useRef<HTMLElement | null>(null);
  const scrollMemory = useRef(new NavigationScrollMemory());
  const activeScrollKey = useRef<string>(location.key);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const matchedCompany = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix) ?? null;
  }, [companies, companyPrefix]);
  const hasUnknownCompanyPrefix =
    Boolean(companyPrefix) && !companiesLoading && companies.length > 0 && !matchedCompany;
  const pluginRoutePath = useMemo(
    () => matchedPluginRoutePath?.toLowerCase() ?? getCompanyRouteSegment(location.pathname, companyPrefix),
    [companyPrefix, location.pathname, matchedPluginRoutePath],
  );
  const routeSidebarCompanyId = matchedCompany?.id ?? null;
  const routeSidebarCompanyPrefix = matchedCompany?.issuePrefix ?? null;
  const { slots: routeSidebarSlots } = usePluginSlots({
    slotTypes: ["page", "routeSidebar"],
    companyId: routeSidebarCompanyId,
    enabled: Boolean(routeSidebarCompanyId && pluginRoutePath),
  });
  const routeSidebarSlot = useMemo(
    () => resolveRouteSidebarSlot(routeSidebarSlots, pluginRoutePath),
    [pluginRoutePath, routeSidebarSlots],
  );
  const sidebarContext = useMemo(
    () => ({
      companyId: routeSidebarCompanyId,
      companyPrefix: routeSidebarCompanyPrefix,
    }),
    [routeSidebarCompanyId, routeSidebarCompanyPrefix],
  );
  // Takeover routes (company settings, plugin `routeSidebar`) no longer replace
  // the app `<Sidebar/>`. Instead the host collapses it to its rail and renders
  // the contextual sidebar in a second pane (PAP-10695). One resolver drives
  // both desktop (SecondarySidebar) and mobile (off-canvas drawer).
  const secondarySidebar = isCompanySettingsRoute ? (
    <CompanySettingsSidebar />
  ) : appsEnabled && appDetailConnectionId ? (
    <AppDetailSidebar kind="connection" connectionId={appDetailConnectionId} />
  ) : appsEnabled && appDetailApplicationId ? (
    <AppDetailSidebar kind="application" applicationId={appDetailApplicationId} />
  ) : appsEnabled && (isAppsRoute || isToolsRoute) ? (
    <AppsSidebar />
  ) : routeSidebarSlot ? (
    <PluginSlotMount
      slot={routeSidebarSlot}
      context={sidebarContext}
      className="h-full w-full"
      missingBehavior="placeholder"
    />
  ) : null;
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as { devServer?: { enabled?: boolean } } | undefined;
      return data?.devServer?.enabled ? 2000 : false;
    },
    refetchIntervalInBackground: true,
  });
  const keyboardShortcutsEnabled = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  }).data?.keyboardShortcuts === true;

  useEffect(() => {
    if (companiesLoading || onboardingTriggered.current) return;
    if (health?.deploymentMode === "authenticated") return;
    // Cloud provisions the single company for a stack, and POST /companies is a
    // 403 floor there — auto-opening the wizard could only dead-end.
    if (health?.cloud) return;
    if (companies.length === 0) {
      onboardingTriggered.current = true;
      openOnboarding();
    }
  }, [companies, companiesLoading, openOnboarding, health?.cloud, health?.deploymentMode]);

  useEffect(() => {
    if (!companyPrefix || companiesLoading || companies.length === 0) return;

    if (!matchedCompany) {
      const fallback = (selectedCompanyId ? companies.find((company) => company.id === selectedCompanyId) : null)
        ?? companies[0]
        ?? null;
      if (fallback && selectedCompanyId !== fallback.id) {
        setSelectedCompanyId(fallback.id, { source: "route_sync" });
      }
      return;
    }

    if (companyPrefix !== matchedCompany.issuePrefix) {
      const suffix = location.pathname.replace(/^\/[^/]+/, "");
      navigate(`/${matchedCompany.issuePrefix}${suffix}${location.search}`, { replace: true });
      return;
    }

    // Stale state (remembered paths, history, bookmarks, restored tabs)
    // deposits users into archived companies long after archiving; a cold
    // arrival bounces to an active company instead of dwelling there.
    // Deliberate visits (the company is already the selection) stay put.
    const bounce = resolveArchivedCompanyBounce({
      matchedCompany,
      selectedCompanyId,
      companies,
    });
    if (bounce) {
      pushToast?.({
        title: `${matchedCompany.name} is archived`,
        body: `Switched to ${bounce.name}.`,
        tone: "info",
        dedupeKey: `archived-company-bounce:${matchedCompany.id}`,
      });
      setSelectedCompanyId(bounce.id, { source: "route_sync" });
      navigate(`/${bounce.issuePrefix}/dashboard`, { replace: true });
      return;
    }

    if (
      shouldSyncCompanySelectionFromRoute({
        selectionSource,
        selectedCompanyId,
        routeCompanyId: matchedCompany.id,
      })
    ) {
      setSelectedCompanyId(matchedCompany.id, { source: "route_sync" });
    }
  }, [
    companyPrefix,
    companies,
    companiesLoading,
    matchedCompany,
    location.pathname,
    location.search,
    navigate,
    pushToast,
    selectionSource,
    selectedCompanyId,
    setSelectedCompanyId,
  ]);

  const togglePanel = togglePanelVisible;
  // Cmd/Ctrl+B: collapse/expand the pinned rail on desktop; on mobile keep
  // toggling the off-canvas drawer.
  const toggleCollapse = useCallback(() => {
    if (isMobile) {
      toggleSidebar();
    } else {
      toggleCollapsed();
    }
  }, [isMobile, toggleSidebar, toggleCollapsed]);
  const openSearch = useCallback(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));
  }, []);

  useCompanyPageMemory();

  useKeyboardShortcuts({
    enabled: keyboardShortcutsEnabled,
    onNewIssue: () => openNewIssue(),
    onSearch: openSearch,
    onToggleSidebar: toggleSidebar,
    onToggleCollapse: toggleCollapse,
    onTogglePanel: togglePanel,
    onShowShortcuts: () => setShortcutsOpen(true),
    onGoToInbox: () => navigate("/inbox"),
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const mainContent = mainContentRef.current;
    return scheduleMainContentFocus(mainContent);
  }, [location.pathname]);

  // Continuously record the scroll offset of the active history entry so a
  // later back/forward navigation can restore it (see NavigationScrollMemory).
  useEffect(() => {
    const main = mainContentRef.current;
    if (!main) return;
    const recordScroll = () => {
      scrollMemory.current.remember(activeScrollKey.current, main.scrollTop);
    };
    main.addEventListener("scroll", recordScroll, { passive: true });
    return () => main.removeEventListener("scroll", recordScroll);
  }, []);

  useLayoutEffect(() => {
    const main = mainContentRef.current;
    const shouldResetScroll = shouldResetScrollOnNavigation({
      previousPathname: previousPathname.current,
      pathname: location.pathname,
      navigationType,
      state: location.state,
    });

    previousPathname.current = location.pathname;

    const isHistoryPop = navigationType === "POP";
    const restoredScrollTop = isHistoryPop ? scrollMemory.current.recall(location.key) : 0;
    activeScrollKey.current = location.key;

    if (isHistoryPop) {
      applyMainContentScrollTop(main, restoredScrollTop);
      // Cached page content can finish laying out a frame after commit; re-apply
      // once it has so the restored offset isn't clamped to a shorter interim height.
      const raf = requestAnimationFrame(() => applyMainContentScrollTop(main, restoredScrollTop));
      return () => cancelAnimationFrame(raf);
    }

    if (shouldResetScroll) {
      resetNavigationScroll(main);
    }
  }, [location.key, location.pathname, location.state, navigationType]);

  return (
    <GeneralSettingsProvider value={{ keyboardShortcutsEnabled }}>
      <>
        <ApplicationShell
          primarySidebar={<Sidebar />}
          primarySidebarFooter={
            <SidebarAccountMenu
              deploymentMode={health?.deploymentMode}
              serverGit={health?.serverInfo?.git}
              version={health?.version}
            />
          }
          secondarySidebar={secondarySidebar}
          forcePrimarySidebarCollapsed={isSkillsRoute}
          banners={
            <>
              <WorktreeBanner />
              <DevRestartBanner devServer={health?.devServer} />
            </>
          }
          header={
            <>
              <StandaloneBrowserControls mobile={isMobile} />
              <BreadcrumbBar />
              {isMobile && isCompanySettingsRoute ? (
                <div className="border-b border-border px-4 pb-3">
                  <CompanySettingsNav />
                </div>
              ) : null}
            </>
          }
          trailingPane={<PropertiesPanel />}
          mobileNavigation={(visible) => <MobileBottomNav visible={visible} />}
          mainRef={mainContentRef}
        >
          {hasUnknownCompanyPrefix ? (
            <NotFoundPage
              scope="invalid_company_prefix"
              requestedPrefix={companyPrefix ?? selectedCompany?.issuePrefix}
            />
          ) : (
            <RouteErrorBoundary>
              <Outlet />
            </RouteErrorBoundary>
          )}
        </ApplicationShell>
        <CommandPalette />
        <NewIssueDialog />
        <NewProjectDialog />
        <NewGoalDialog />
        <NewAgentDialog />
        <KeyboardShortcutsCheatsheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <ToastViewport />
      </>
    </GeneralSettingsProvider>
  );
}
