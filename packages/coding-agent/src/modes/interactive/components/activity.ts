import {
	type Component,
	Container,
	MouseRegion,
	Spacer,
	Text,
	type TuiMouseEvent,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { CompactView } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { BashExecutionComponent } from "./bash-execution.ts";
import { BranchSummaryMessageComponent } from "./branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./compaction-summary-message.ts";
import { CustomEntryComponent } from "./custom-entry.ts";
import { CustomMessageComponent } from "./custom-message.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";

class Activity extends Container {
	readonly content = new Container();
	private expanded: boolean;
	private readonly heading = new Text("", 0, 0);
	private readonly toggle = new MouseRegion(this.heading, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.setExpanded(!this.expanded);
		return { handled: true };
	});

	constructor(expanded: boolean) {
		super();
		this.expanded = expanded;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	override render(width: number): string[] {
		let calls = 0;
		let updates = 0;
		let running = 0;
		let failed = 0;
		let cancelled = 0;
		for (const child of this.content.children) {
			if (child instanceof ToolExecutionComponent || child instanceof BashExecutionComponent) {
				calls++;
				const status = child.getActivityStatus();
				if (status === "running") running++;
				if (status === "error") failed++;
				if (status === "cancelled") cancelled++;
			} else if (!(child instanceof Spacer)) updates++;
		}
		const counts = [
			calls ? `${calls} call${calls === 1 ? "" : "s"}` : "",
			updates ? `${updates} update${updates === 1 ? "" : "s"}` : "",
			running ? `${running} running` : "",
			failed ? theme.fg("error", `${failed} failed`) : "",
			cancelled ? theme.fg("warning", `${cancelled} cancelled`) : "",
		].filter(Boolean);
		this.heading.setText(
			truncateToWidth(theme.fg("muted", `${this.expanded ? "▾" : "▸"} Activity · ${counts.join(" · ")}`), width),
		);
		this.children = this.expanded ? [this.toggle, this.content] : [this.toggle];
		return super.render(width);
	}
}

/** Group presentation only: transcript children stay available for insertion and live updates. */
export class ChatContainer extends Container {
	private compactView: CompactView = false;
	private expanded = false;
	private readonly activity = new WeakSet<Component>();
	private groups = new Map<Component, Activity>();
	private readonly presentation = new Container();

	addActivity(component: Component): void {
		this.activity.add(component);
		this.addChild(component);
	}

	setCompactView(compactView: CompactView): void {
		this.compactView = compactView;
		this.setExpanded(this.expanded);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const group of this.groups.values()) group.setExpanded(expanded || this.compactView === "hybrid");
	}

	override clear(): void {
		super.clear();
		this.groups.clear();
		this.presentation.clear();
	}

	override render(width: number): string[] {
		if (!this.compactView) return super.render(width);
		this.presentation.clear();
		const groups = new Map<Component, Activity>();
		let group: Activity | undefined;
		let spacers: Component[] = [];
		for (const child of this.children) {
			if (child instanceof Spacer) {
				spacers.push(child);
				continue;
			}
			if (child instanceof AssistantMessageComponent && child.render(width).length === 0) continue;
			if (
				this.activity.has(child) ||
				child instanceof ToolExecutionComponent ||
				child instanceof BashExecutionComponent ||
				child instanceof CustomMessageComponent ||
				child instanceof CustomEntryComponent ||
				child instanceof BranchSummaryMessageComponent ||
				child instanceof CompactionSummaryMessageComponent
			) {
				if (!group) {
					group = this.groups.get(child) ?? new Activity(this.expanded || this.compactView === "hybrid");
					group.content.clear();
					groups.set(child, group);
					this.presentation.addChild(group);
				}
				group.content.children.push(...spacers, child);
			} else {
				group = undefined;
				this.presentation.children.push(...spacers, child);
			}
			spacers = [];
		}
		this.presentation.children.push(...spacers);
		this.groups = groups;
		return this.presentation.render(width);
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		return this.compactView ? this.presentation.handleMouse(event) : super.handleMouse(event);
	}
}
