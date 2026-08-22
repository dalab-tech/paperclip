// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider, useSidebar } from "../context/SidebarContext";
import { ApplicationShell } from "./ApplicationShell";

function OpenNavigationButton() {
  const { sidebarOpen, setSidebarOpen } = useSidebar();
  return (
    <button
      type="button"
      aria-label="Open navigation"
      aria-expanded={sidebarOpen}
      onClick={() => setSidebarOpen(true)}
    >
      Open
    </button>
  );
}

describe("ApplicationShell", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes("max-width") ? window.innerWidth < 768 : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders primary, contextual, header, main, and trailing regions on desktop", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });

    await act(async () => {
      root.render(
        <SidebarProvider>
          <ApplicationShell
            primarySidebar={<nav aria-label="Primary">Primary</nav>}
            secondarySidebar={<nav aria-label="Contextual">Contextual</nav>}
            header={<header>Header</header>}
            trailingPane={<aside>Properties</aside>}
          >
            Page
          </ApplicationShell>
        </SidebarProvider>,
      );
    });

    expect(container.querySelector('[aria-label="Primary"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Contextual"]')).not.toBeNull();
    expect(container.querySelector("#main-content")?.textContent).toContain("Page");
    expect(container.textContent).toContain("Header");
    expect(container.textContent).toContain("Properties");
  });

  it("opens the real Paperclip mobile drawer from a supplied header control", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });

    await act(async () => {
      root.render(
        <SidebarProvider>
          <ApplicationShell
            primarySidebar={<nav aria-label="Primary">Primary</nav>}
            header={<OpenNavigationButton />}
          >
            Page
          </ApplicationShell>
        </SidebarProvider>,
      );
    });

    const open = container.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]');
    expect(open?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[aria-label="Close sidebar"]')).toBeNull();

    await act(async () => open?.click());

    expect(open?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[aria-label="Close sidebar"]')).not.toBeNull();
  });
});
