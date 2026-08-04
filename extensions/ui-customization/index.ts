import { homedir } from "node:os";
import { relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  emptyGitInfoState,
  emptyModelInfoState,
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  isGitInfoState,
  isModelInfoState,
} from "../shared/dashboard-state.ts";

interface RenderableNode {
  children?: RenderableNode[];
  invalidate(): void;
  render(width: number): string[];
}

interface DashboardTui extends RenderableNode {
  requestRender(force?: boolean): void;
}

interface ExpandableNode extends RenderableNode {
  setExpanded(expanded: boolean): void;
}

interface ResourceSection {
  name: string;
  items: string[];
}

const RESOURCE_SECTION_NAMES = new Set(["Context", "Skills", "Extensions"]);

const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

function sanitizeTerminalLabel(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function hasChildren(
  component: RenderableNode,
): component is RenderableNode & { children: RenderableNode[] } {
  return Array.isArray(component.children);
}

function renderedText(component: RenderableNode) {
  try {
    return component.render(200).join("\n").replace(ANSI_PATTERN, "");
  } catch {
    return "";
  }
}

function isExpandable(component: RenderableNode): component is ExpandableNode {
  return (
    "setExpanded" in component && typeof component.setExpanded === "function"
  );
}

function parseResourceSection(component: RenderableNode) {
  if (isExpandable(component)) component.setExpanded(false);

  const lines = renderedText(component)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const match = lines[0]?.match(/^\[([^\]]+)\]$/);
  if (!match || !RESOURCE_SECTION_NAMES.has(match[1]!)) return;

  return {
    name: match[1]!,
    items: lines
      .slice(1)
      .join(" ")
      .split(/,\s+/)
      .map((item) => item.trim())
      .filter(Boolean),
  } satisfies ResourceSection;
}

function extractResourceSections(component: RenderableNode): ResourceSection[] {
  if (!hasChildren(component)) return [];

  const sections: ResourceSection[] = [];
  const indexes: number[] = [];
  for (let index = 0; index < component.children.length; index += 1) {
    const section = parseResourceSection(component.children[index]!);
    if (!section) continue;
    sections.push(section);
    indexes.push(index);
  }

  if (sections.length > 0) {
    for (const index of indexes.reverse()) {
      const removeCount =
        component.children[index + 1] &&
        renderedText(component.children[index + 1]!).trim() === ""
          ? 2
          : 1;
      component.children.splice(index, removeCount);
    }
    component.invalidate();
    return sections;
  }

  for (const child of component.children) {
    const nested = extractResourceSections(child);
    if (nested.length > 0) return nested;
  }

  return [];
}

function hideThemesSection(component: RenderableNode) {
  if (!hasChildren(component)) return false;

  for (let index = 0; index < component.children.length; index += 1) {
    const child = component.children[index]!;
    const firstLine = renderedText(child)
      .split("\n")
      .find((line) => line.trim())
      ?.trim();

    if (firstLine === "[Themes]") {
      const removeCount =
        component.children[index + 1] &&
        renderedText(component.children[index + 1]!).trim() === ""
          ? 2
          : 1;
      component.children.splice(index, removeCount);
      component.invalidate();
      return true;
    }

    if (hideThemesSection(child)) return true;
  }

  return false;
}

function padToWidth(text: string, width: number) {
  const fitted = truncateToWidth(text, width, "…");
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function wrapItems(items: string[], width: number) {
  if (width <= 0) return [];

  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    const next = line ? `${line} · ${item}` : item;
    if (visibleWidth(next) <= width) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = truncateToWidth(item, width, "…");
  }
  if (line) lines.push(line);
  return lines;
}

class ResourcePanel implements RenderableNode {
  private sections: ResourceSection[] = [];
  private expanded = new Set<string>();

  constructor(private readonly theme: Theme) {}

  setSections(sections: ResourceSection[]) {
    this.sections = sections;
  }

  toggle(name: "Skills" | "Extensions") {
    if (this.expanded.has(name)) {
      this.expanded.delete(name);
      return false;
    }
    this.expanded.add(name);
    return true;
  }

  render(width: number) {
    if (this.sections.length === 0 || width < 24) return [];

    const contentWidth = width - 4;
    const border = (text: string) => this.theme.fg("borderMuted", text);
    const row = (content: string) =>
      `${border("│")} ${padToWidth(content, contentWidth)} ${border("│")}`;
    const separator = `${border("├")}${border("─".repeat(width - 2))}${border("┤")}`;
    const context = this.sections.find((section) => section.name === "Context");
    const contextCount = context?.items.length ?? 0;
    const contextNoun = contextCount === 1 ? "file" : "files";
    const title = ` context · ${contextCount} ${contextNoun} `;
    const topFill = "─".repeat(Math.max(0, width - title.length - 3));
    const lines = [
      `${border("╭─")}${this.theme.fg("accent", this.theme.bold(title))}${border(`${topFill}╮`)}`,
      row(this.theme.fg("dim", context?.items.join(" · ") ?? "none")),
    ];

    for (const name of ["Skills", "Extensions"] as const) {
      const section = this.sections.find(
        (candidate) => candidate.name === name,
      );
      if (!section) continue;

      lines.push(separator);
      const command = `/${name.toLowerCase()}`;
      const heading = `${this.theme.fg("text", this.theme.bold(name))} ${this.theme.fg("muted", `· ${section.items.length}`)}`;
      lines.push(
        row(columns(heading, this.theme.fg("accent", command), contentWidth)),
      );

      const items = this.expanded.has(name)
        ? section.items
        : section.items.slice(0, 3);
      const suffix =
        !this.expanded.has(name) && section.items.length > items.length
          ? ` · +${section.items.length - items.length}`
          : "";
      for (const detail of wrapItems(
        items.length > 0
          ? [...items.slice(0, -1), `${items.at(-1)}${suffix}`]
          : [],
        contentWidth,
      )) {
        lines.push(row(this.theme.fg("dim", detail)));
      }
    }

    lines.push(`${border("╰")}${border("─".repeat(width - 2))}${border("╯")}`);
    return ["", ...lines, ""];
  }

  invalidate() {}
}

function formatTokens(tokens: number) {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  const display = cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
  return sanitizeTerminalLabel(display);
}

function columns(left: string, right: string, width: number) {
  if (!right) return truncateToWidth(left, width);

  const naturalGap = width - visibleWidth(left) - visibleWidth(right);
  if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const rightWidth = Math.max(1, width - leftWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(right, rightWidth);
  const gap = Math.max(
    1,
    width - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );
  return truncateToWidth(
    `${fittedLeft}${" ".repeat(gap)}${fittedRight}`,
    width,
  );
}

export default function uiCustomization(pi: ExtensionAPI) {
  let title = "pi";
  let modelInfo = emptyModelInfoState();
  let gitInfo = emptyGitInfoState();
  let requestRender: (() => void) | undefined;
  let activeTui: DashboardTui | undefined;
  let resourcePanel: ResourcePanel | undefined;
  let resourcePanelTimers: Array<ReturnType<typeof setTimeout>> = [];

  const stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
    if (!isModelInfoState(value)) return;
    modelInfo = value;
    requestRender?.();
  });

  const stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
    if (!isGitInfoState(value)) return;
    gitInfo = value;
    requestRender?.();
  });

  function scheduleResourcePanel(tui: DashboardTui) {
    for (const timer of resourcePanelTimers) clearTimeout(timer);
    resourcePanelTimers = [];

    for (const delay of [0, 50, 250, 1_000]) {
      resourcePanelTimers.push(
        setTimeout(() => {
          const sections = extractResourceSections(tui);
          const changed = sections.length > 0;
          if (changed) resourcePanel?.setSections(sections);
          if (hideThemesSection(tui) || changed) tui.requestRender(true);
        }, delay),
      );
    }
  }

  function toggleResourceSection(
    name: "Skills" | "Extensions",
    ctx: ExtensionContext,
  ) {
    if (!resourcePanel) {
      ctx.ui.notify("The resource panel is not available", "warning");
      return;
    }
    const expanded = resourcePanel.toggle(name);
    requestRender?.();
    ctx.ui.notify(`${name}: ${expanded ? "expanded" : "collapsed"}`, "info");
  }

  pi.registerCommand("skills", {
    description: "Expand or collapse loaded skills in the context bar",
    handler: async (_args, ctx) => toggleResourceSection("Skills", ctx),
  });

  pi.registerCommand("extensions", {
    description: "Expand or collapse loaded extensions in the context bar",
    handler: async (_args, ctx) => toggleResourceSection("Extensions", ctx),
  });

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((tui, theme) => {
      activeTui = tui;
      requestRender = () => tui.requestRender();
      resourcePanel = new ResourcePanel(theme);
      scheduleResourcePanel(tui);
      return resourcePanel;
    });

    ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender();

      return {
        invalidate() {},
        render(width: number) {
          const directory = theme.fg("text", formatDirectory(ctx.cwd));
          const fileLabel = gitInfo.changedFiles === 1 ? "file" : "files";
          let git = gitInfo.branch
            ? `${gitInfo.branch} · ${gitInfo.changedFiles} ${fileLabel} changed`
            : "";

          if (gitInfo.pullRequest) {
            const prLabel = `PR #${gitInfo.pullRequest.number}`;
            const linkedPr = getCapabilities().hyperlinks
              ? hyperlink(prLabel, gitInfo.pullRequest.url)
              : prLabel;
            git += ` · ${linkedPr}`;
          }

          const contextPercent =
            modelInfo.contextPercent === null
              ? "?"
              : `${Math.round(modelInfo.contextPercent)}`;
          const contextWindow =
            modelInfo.contextWindow > 0
              ? formatTokens(modelInfo.contextWindow)
              : "?";
          const tps =
            modelInfo.tokensPerSecond === null
              ? "— tok/s"
              : `${Math.round(modelInfo.tokensPerSecond)} tok/s`;
          const usage = `${contextPercent}%/${contextWindow} · $${modelInfo.cost.toFixed(2)} · ${tps}`;
          const model = modelInfo.provider
            ? `${modelInfo.provider}/${modelInfo.modelId} · ${modelInfo.thinking}`
            : modelInfo.modelId;

          const lines = [
            columns(directory, theme.fg("muted", model), width),
            columns(theme.fg("muted", usage), theme.fg("muted", git), width),
          ];

          // Extension statuses render after the two dashboard lines, one per row.
          const statuses = footerData.getExtensionStatuses();
          const statusLines = Array.from(statuses.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, text]) => text.split("\n"));
          for (const statusLine of statusLines) {
            lines.push(
              truncateToWidth(statusLine, width, theme.fg("dim", "...")),
            );
          }

          return lines;
        },
      };
    });

    ctx.ui.setTitle(`pi · ${title}`);
    pi.events.emit(REFRESH_CHANNEL, undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    title = formatDirectory(ctx.cwd);
    modelInfo = emptyModelInfoState();
    gitInfo = emptyGitInfoState();
    install(ctx);
  });

  pi.on("resources_discover", () => {
    if (activeTui) scheduleResourcePanel(activeTui);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopModelListener();
    stopGitListener();
    for (const timer of resourcePanelTimers) clearTimeout(timer);
    resourcePanelTimers = [];
    activeTui = undefined;
    resourcePanel = undefined;
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
