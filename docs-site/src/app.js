const DEFAULT_ROUTE = "overview";
const THEME_STORAGE_KEY = "qaas-docs-theme";
const THEME_STATES = Object.freeze(["system", "light", "dark"]);

export function normalizeTheme(value) {
  return THEME_STATES.includes(value) ? value : "system";
}

export function nextTheme(value) {
  const current = normalizeTheme(value);
  const index = THEME_STATES.indexOf(current);
  return THEME_STATES[(index + 1) % THEME_STATES.length];
}

export function applyTheme(
  value,
  {
    root = document.documentElement,
    control = document.querySelector("[data-theme-toggle]"),
    status = document.querySelector("[data-theme-status]"),
    announce = false,
  } = {},
) {
  const theme = normalizeTheme(value);
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }

  const labels = {
    system: "Auto",
    light: "Light",
    dark: "Dark",
  };
  const icons = {
    system: "◐",
    light: "☀",
    dark: "☾",
  };

  if (control) {
    const following = nextTheme(theme);
    control.dataset.themeState = theme;
    control.setAttribute(
      "aria-label",
      `Color theme: ${labels[theme]}. Switch to ${labels[following]}.`,
    );
    control.setAttribute(
      "title",
      `Color theme: ${labels[theme]}. Switch to ${labels[following]}.`,
    );
    const label = control.querySelector("[data-theme-label]");
    const icon = control.querySelector("[data-theme-icon]");
    if (label) label.textContent = labels[theme];
    if (icon) icon.textContent = icons[theme];
  }

  if (announce && status) {
    status.textContent =
      theme === "system"
        ? "Color theme follows the operating system."
        : `${labels[theme]} color theme selected.`;
  }

  return theme;
}

export function initializeTheme(source = document, browserWindow = window) {
  const control = source.querySelector("[data-theme-toggle]");
  const status = source.querySelector("[data-theme-status]");
  let theme = "system";

  try {
    theme = normalizeTheme(
      browserWindow.localStorage?.getItem(THEME_STORAGE_KEY),
    );
  } catch {
    theme = "system";
  }

  const commit = (value, announce = false) => {
    theme = applyTheme(value, {
      root: source.documentElement,
      control,
      status,
      announce,
    });
    try {
      if (theme === "system") {
        browserWindow.localStorage?.removeItem(THEME_STORAGE_KEY);
      } else {
        browserWindow.localStorage?.setItem(THEME_STORAGE_KEY, theme);
      }
    } catch {
      // A storage policy must not prevent theme selection for this page view.
    }
  };

  commit(theme);
  control?.addEventListener("click", () => {
    commit(nextTheme(theme), true);
  });

  const systemPreference = browserWindow.matchMedia?.(
    "(prefers-color-scheme: dark)",
  );
  systemPreference?.addEventListener?.("change", () => {
    if (theme === "system") commit("system");
  });

  return Object.freeze({
    get state() {
      return theme;
    },
  });
}

export function normalizeRoute(hash, availableRoutes) {
  const candidate = String(hash ?? "")
    .replace(/^#\/?/, "")
    .split(/[/?]/, 1)[0]
    .trim()
    .toLowerCase();

  return availableRoutes.has(candidate) ? candidate : DEFAULT_ROUTE;
}

export function parseSiteConfig(source = document) {
  const element = source.getElementById("site-config");
  if (!element) {
    throw new Error("Missing injected site configuration.");
  }

  const config = JSON.parse(element.textContent || "{}");
  if (
    typeof config.title !== "string" ||
    typeof config.version !== "string" ||
    typeof config.repositoryUrl !== "string"
  ) {
    throw new Error("Injected site configuration is incomplete.");
  }

  return config;
}

export function applyConfig(config, source = document) {
  const repositoryLink = source.querySelector("[data-repository-link]");
  if (repositoryLink) {
    repositoryLink.href = config.repositoryUrl;
    repositoryLink.setAttribute(
      "aria-label",
      `Open the ${config.title} repository in a new tab`,
    );
  }

  const documentationValues = [
    ["helmDocsUrl", config.helmDocsUrl],
    ["wikiallDocsUrl", config.wikiallDocsUrl],
  ];
  for (const [name, value] of documentationValues) {
    const element = source.querySelector(`[data-config="${name}"]`);
    if (!element) continue;
    element.textContent =
      typeof value === "string" && value !== "" ? value : "Not configured";
  }
}

export function createRouter({
  source = document,
  browserWindow = window,
  config,
} = {}) {
  const routeElements = new Map(
    Array.from(source.querySelectorAll("[data-route]"), (element) => [
      element.dataset.route,
      element,
    ]),
  );
  const routeLinks = Array.from(source.querySelectorAll("[data-route-link]"));
  const announcer = source.querySelector(".route-announcer");
  let initialRender = true;

  function render() {
    const routeName = normalizeRoute(
      browserWindow.location.hash,
      new Set(routeElements.keys()),
    );
    const activeRoute = routeElements.get(routeName);

    for (const [name, element] of routeElements) {
      const active = name === routeName;
      element.hidden = !active;
      element.classList.toggle("is-active", active);
    }

    for (const link of routeLinks) {
      if (link.dataset.routeLink === routeName) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    }

    const routeTitle = activeRoute?.dataset.routeTitle ?? "Documentation";
    source.title = `${routeTitle} · ${config.title} documentation`;

    if (!initialRender) {
      browserWindow.scrollTo(0, 0);
      const heading = activeRoute?.querySelector("h1");
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
      }
      if (announcer) {
        announcer.textContent = `${routeTitle} documentation loaded`;
      }
    }

    const activeLink = routeLinks.find(
      (link) => link.dataset.routeLink === routeName,
    );
    activeLink?.scrollIntoView({ block: "nearest", inline: "nearest" });
    initialRender = false;
    return routeName;
  }

  return Object.freeze({ render });
}

export function initialize(source = document, browserWindow = window) {
  initializeTheme(source, browserWindow);
  const config = parseSiteConfig(source);
  applyConfig(config, source);
  const router = createRouter({ source, browserWindow, config });
  router.render();
  browserWindow.addEventListener("hashchange", () => router.render());
  return router;
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  initialize();
}
