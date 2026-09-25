import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECT_TOOL_DECISION,
  classifyConnectTool,
} from "../../dist/connect/tool-classifier.js";

const PROTECT_CASES = [
  "send_email",
  "send_sms",
  "send_notification",
  "charge_customer",
  "refund_payment",
  "transfer_funds",
  "pay_invoice",
  "create_invoice",
  "update_invoice",
  "delete_invoice",
  "create_order",
  "place_order",
  "cancel_order",
  "book_flight",
  "reserve_table",
  "cancel_booking",
  "schedule_meeting",
  "reschedule_meeting",
  "invite_member",
  "remove_member",
  "revoke_access",
  "grant_role",
  "deploy_service",
  "provision_server",
  "upload_file",
  "rename_file",
  "move_file",
  "publish_article",
  "approve_request",
  "reject_request",
  "merge_pull_request",
  "commit_changes",
  "archive_record",
  "restore_backup",
  "start_job",
  "stop_job",
  "subscribe_user",
  "unsubscribe_user",
  "follow_user",
  "unfollow_user",
  "share_document",
  "comment_on_issue",
  "mark_notification_read",
  "enable_feature",
  "disable_account",
  "lock_account",
  "unlock_account",
  "activate_subscription",
  "deactivate_subscription",
  "sign_contract",
  "submit_form",
];

const BYPASS_CASES = [
  "search_web",
  "search_messages",
  "search_emails",
  "search_posts",
  "list_orders",
  "list_bookings",
  "list_users",
  "list_comments",
  "get_order",
  "get_message",
  "get_email",
  "get_customer",
  "get_weather",
  "fetch_invoice",
  "fetch_orders",
  "fetch_messages",
  "retrieve_document",
  "retrieve_customer",
  "read_file",
  "read_email",
  "read_message",
  "view_profile",
  "view_invoice",
  "inspect_schema",
  "inspect_document",
  "preview_report",
  "preview_invoice",
  "check_status",
  "check_balance",
  "get_metrics",
  "get_stats",
  "lookup_customer",
  "lookup_order",
  "find_booking",
  "find_user",
  "generate_report",
  "generate_summary",
  "generate_completion",
  "summarize_document",
  "translate_text",
  "calculate_tax",
  "compute_hash",
  "convert_units",
  "format_markdown",
  "parse_json",
  "render_template",
  "validate_schema",
  "analyze_text",
  "describe_image",
  "show_history",
  "status_report",
];

const AMBIGUOUS_CASES = [
  "get_or_create_customer",
  "search_and_send_email",
  "fetch_and_delete_file",
  "view_and_update_profile",
  "read_and_archive_message",
  "ensure_user",
  "sync_account",
  "process_payment",
  "execute_task",
  "run_workflow",
  "handle_request",
  "manage_user",
  "reconcile_invoice",
  "import_data",
  "export_data",
  "download_file",
  "copy_file",
  "call_api",
  "invoke_service",
  "upsert_record",
  "trigger_workflow",
  "apply_change",
  "persist_result",
];

function classifyNames(names) {
  return names.map(name => ({
    name,
    decision: classifyConnectTool({ name }).decision,
  }));
}

test("classifier corpus contains at least 125 representative tool names", () => {
  assert.ok(
    PROTECT_CASES.length + BYPASS_CASES.length + AMBIGUOUS_CASES.length >= 125,
  );
});

test("known consequential tools never silently BYPASS", () => {
  const unsafe = classifyNames(PROTECT_CASES)
    .filter(item => item.decision === CONNECT_TOOL_DECISION.BYPASS);

  assert.deepEqual(unsafe, []);
});

test("ambiguous tools never silently BYPASS", () => {
  const unsafe = classifyNames(AMBIGUOUS_CASES)
    .filter(item => item.decision === CONNECT_TOOL_DECISION.BYPASS);

  assert.deepEqual(unsafe, []);
});

test("obvious consequential-tool coverage is at least 80 percent", () => {
  const results = classifyNames(PROTECT_CASES);
  const protectedCount = results
    .filter(item => item.decision === CONNECT_TOOL_DECISION.PROTECT)
    .length;
  const coverage = protectedCount / results.length;

  assert.ok(
    coverage >= 0.8,
    `protect coverage ${(coverage * 100).toFixed(1)}% (${protectedCount}/${results.length})`,
  );
});

test("obvious read/generation bypass coverage is at least 90 percent", () => {
  const results = classifyNames(BYPASS_CASES);
  const bypassCount = results
    .filter(item => item.decision === CONNECT_TOOL_DECISION.BYPASS)
    .length;
  const coverage = bypassCount / results.length;

  assert.ok(
    coverage >= 0.9,
    `bypass coverage ${(coverage * 100).toFixed(1)}% (${bypassCount}/${results.length})`,
  );
});
