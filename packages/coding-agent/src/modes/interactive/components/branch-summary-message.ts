import type { BranchSummaryMessage } from "../../../core/messages.ts";
import { SummaryMessageComponent } from "./summary-message.ts";

/**
 * Component that renders a branch summary message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class BranchSummaryMessageComponent extends SummaryMessageComponent<BranchSummaryMessage> {
	protected override getSummaryDisplay() {
		return {
			tag: "branch",
			expandedHeader: "**Branch Summary**\n\n",
			collapsedLabel: "Branch summary",
		};
	}
}
