import React, {
  type RefObject,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import { Box, Text } from "../ink.js";
import ScrollBox, {
  type ScrollBoxHandle,
} from "../ink/components/ScrollBox.js";
import { useKeybindings } from "../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../keybindings/KeybindingContext.js";
import { getWorkbenchBufferProviderController } from "./buffer/providers/BufferProviderController.js";
import {
  dismissStaleEditorProposalRecord,
  editorProposalRecord,
  editorProposalStoreRevision,
  markEditorProposalPending,
  resolveEditorProposalRecord,
  subscribeEditorProposalStore,
  type EditorProposalRecord,
} from "./editorProposalStore.js";
import { useWorkbenchDispatch } from "./state.js";

export function EditorProposalRail({
  proposalId,
  focused,
  scrollRef,
}: {
  readonly proposalId: string;
  readonly focused: boolean;
  readonly scrollRef?: RefObject<ScrollBoxHandle | null>;
}): React.ReactElement {
  useSyncExternalStore(
    subscribeEditorProposalStore,
    editorProposalStoreRevision,
    editorProposalStoreRevision,
  );
  const record = editorProposalRecord(proposalId);
  const dispatch = useWorkbenchDispatch();
  const [selectedEdit, setSelectedEdit] = useState(0);
  const busy = record?.status === "accepting" || record?.status === "rejecting";
  const discardOnly = record?.reviewMode === "discard_only";
  const acceptanceRecovery = record?.reviewMode === "acceptance_recovery";
  const edits = record?.proposal.edits ?? [];
  const selected = edits[Math.min(selectedEdit, Math.max(0, edits.length - 1))];
  useEffect(() => {
    scrollRef?.current?.scrollTo(0);
  }, [scrollRef, selected?.id]);

  const closeRail = useCallback((): void => {
    dispatch({ type: "setRail", rail: null });
    dispatch({ type: "focus", pane: "surface" });
  }, [dispatch]);

  const resolve = useCallback(
    async (action: "accept" | "reject"): Promise<void> => {
      if (!record) {
        if (action === "reject") closeRail();
        return;
      }
      if (busy) return;
      if (discardOnly && action === "accept") return;
      // A stale accept clears Neovim's shadow as part of its revision
      // validation failure. Rejecting that now-missing shadow can only return
      // the same stale result forever, so q/n/close is a local dismissal. Do
      // not use this path for acknowledgement: those records describe a local
      // outcome the daemon still needs to durably confirm.
      if (
        action === "reject" &&
        record.status === "stale" &&
        record.reviewMode === "accept_or_reject" &&
        record.staleDiscardActive !== true &&
        dismissStaleEditorProposalRecord(proposalId)
      ) {
        closeRail();
        return;
      }
      markEditorProposalPending(
        proposalId,
        action === "accept" ? "accepting" : "rejecting",
      );
      const controller = getWorkbenchBufferProviderController();
      let result;
      try {
        result =
          action === "reject" &&
          (record.status === "stale" || record.status === "error") &&
          record.staleDiscardActive === true &&
          record.discardStale !== undefined
            ? await record.discardStale()
            : record.resolve !== undefined
              ? await record.resolve(action)
              : action === "accept"
                ? await controller.acceptProposal(proposalId)
                : await controller.rejectProposal(proposalId);
      } catch (error) {
        result = {
          ok: false as const,
          proposalId,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      resolveEditorProposalRecord(result);
      if (result.ok) closeRail();
    },
    [busy, closeRail, discardOnly, proposalId, record],
  );

  useRegisterKeybindingContext("Surface", focused);
  useKeybindings(
    {
      "surface:up": () => setSelectedEdit((value) => Math.max(0, value - 1)),
      "surface:down": () =>
        setSelectedEdit((value) =>
          Math.min(Math.max(0, edits.length - 1), value + 1),
        ),
      "surface:pageUp": () =>
        scrollEditorProposalPage(scrollRef?.current ?? null, "up"),
      "surface:pageDown": () =>
        scrollEditorProposalPage(scrollRef?.current ?? null, "down"),
      "surface:top": () =>
        scrollEditorProposalToEdge(scrollRef?.current ?? null, "top"),
      "surface:bottom": () =>
        scrollEditorProposalToEdge(scrollRef?.current ?? null, "bottom"),
      "surface:accept": () => void resolve("accept"),
      "surface:reject": () => void resolve("reject"),
      "surface:open": () => void resolve("accept"),
      "workbench:closeSurface": () => void resolve("reject"),
    },
    { context: "Surface", isActive: focused },
  );

  if (!record) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="warning">EDITOR PROPOSAL</Text>
        <Text dimColor>The proposal is no longer available.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <Box
        flexDirection="column"
        flexShrink={0}
        paddingX={1}
        borderBottom
        borderColor={focused ? "text" : "lineSoft"}
      >
        <Text bold color={focused ? "text" : "inactive"}>
          {acceptanceRecovery ? "EDITOR PROPOSAL RECOVERY" : "EDITOR PROPOSAL"}
        </Text>
        <Text wrap="truncate-end">
          {record.proposal.path || "[No Name]"} · {record.proposal.summary}
        </Text>
        {record.proposal.base_end_of_line !== undefined &&
        record.proposal.new_end_of_line !== undefined &&
        record.proposal.base_end_of_line !== record.proposal.new_end_of_line ? (
          <Text color="suggestion" wrap="truncate-end">
            {record.proposal.new_end_of_line
              ? "+ final newline"
              : "- final newline"}
          </Text>
        ) : null}
        <Text
          color={
            record.status === "error" || record.status === "stale"
              ? "error"
              : record.status === "unavailable"
                ? "warning"
                : record.status === "acknowledgement"
                  ? "warning"
                  : record.status === "accepted"
                    ? "success"
                    : "warning"
          }
          wrap="truncate-end"
        >
          {proposalStatus(record.status, record.message, record.reviewMode)}
        </Text>
        <Text dimColor wrap="truncate-end">
          {record.status === "acknowledgement"
            ? record.acknowledgementAction === "reject"
              ? "j/k change · PgUp/PgDn scroll · n/q retry discard acknowledgement"
              : "j/k change · PgUp/PgDn scroll · y/enter retry apply acknowledgement"
            : discardOnly
              ? record.status === "error"
                ? "n/q retry explicit discard"
                : "n/q explicitly discard · source was not persisted"
              : acceptanceRecovery
                ? record.status === "error"
                  ? "y/enter retry acknowledgement · n/q retry discard"
                  : "y/enter finish acceptance · n/q discard commitment"
                : record.status === "stale"
                  ? record.staleDiscardActive === true
                    ? "j/k change · PgUp/PgDn scroll · n/q discard commitment"
                    : "j/k change · PgUp/PgDn scroll · n/q dismiss"
                  : "j/k change · PgUp/PgDn scroll · y/enter accept · n/q reject"}
        </Text>
      </Box>
      {discardOnly ? (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Text color="warning" wrap="wrap">
            This proposal survived only as a content-free safety commitment. Its
            before/after source disappeared when the daemon restarted, so it
            cannot be reviewed or accepted.
          </Text>
          <Text dimColor wrap="wrap">
            Press n or q to explicitly discard the commitment and continue.
          </Text>
        </Box>
      ) : null}
      {acceptanceRecovery ? (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Text color="warning" wrap="wrap">
            The proposal source is unavailable, so no before/after preview is
            shown. The live buffer exactly matches the committed replacement
            hash.
          </Text>
          <Text color="success" wrap="wrap">
            Accept finishes daemon acknowledgement.
          </Text>
          <Text dimColor wrap="wrap">
            Reject/discard removes only the commitment and does not revert
            current buffer bytes.
          </Text>
        </Box>
      ) : null}
      {selected ? (
        scrollRef ? (
          <ScrollBox
            ref={scrollRef}
            flexDirection="column"
            flexGrow={1}
            width="100%"
          >
            <ProposalPreview
              edit={selected}
              selectedEdit={selectedEdit}
              editCount={edits.length}
            />
          </ScrollBox>
        ) : (
          <Box
            flexDirection="column"
            flexGrow={1}
            minHeight={0}
            overflow="hidden"
          >
            <ProposalPreview
              edit={selected}
              selectedEdit={selectedEdit}
              editCount={edits.length}
            />
          </Box>
        )
      ) : null}
    </Box>
  );
}

export function scrollEditorProposalPage(
  handle: ScrollBoxHandle | null,
  direction: "up" | "down",
): void | false {
  if (!handle) return false;
  const distance = Math.max(1, Math.floor(handle.getViewportHeight() / 2));
  const current = handle.getScrollTop() + handle.getPendingDelta();
  const maximum = Math.max(
    0,
    handle.getScrollHeight() - handle.getViewportHeight(),
  );
  const target = Math.max(
    0,
    Math.min(maximum, current + (direction === "up" ? -distance : distance)),
  );
  handle.scrollTo(target);
}

export function scrollEditorProposalToEdge(
  handle: ScrollBoxHandle | null,
  edge: "top" | "bottom",
): void | false {
  if (!handle) return false;
  handle.scrollTo(
    edge === "top"
      ? 0
      : Math.max(0, handle.getScrollHeight() - handle.getViewportHeight()),
  );
}

function ProposalPreview({
  edit,
  selectedEdit,
  editCount,
}: {
  readonly edit: {
    readonly id: string;
    readonly start_line: number;
    readonly start_column: number;
    readonly end_line: number;
    readonly end_column: number;
    readonly old_text: string;
    readonly new_text: string;
  };
  readonly selectedEdit: number;
  readonly editCount: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Text color="suggestion" wrap="truncate-end">
        Change {selectedEdit + 1}/{editCount} · L{edit.start_line}:
        {edit.start_column}–L{edit.end_line}:{edit.end_column} · {edit.id}
      </Text>
      {previewLines(edit.old_text, "-").map((line, index) => (
        <Text key={`old:${index}`} color="error" wrap="wrap">
          {line}
        </Text>
      ))}
      {previewLines(edit.new_text, "+").map((line, index) => (
        <Text key={`new:${index}`} color="success" wrap="wrap">
          {line}
        </Text>
      ))}
    </Box>
  );
}

function previewLines(text: string, prefix: "-" | "+"): readonly string[] {
  if (text.length === 0) return [`${prefix} ∅`];
  return text.split("\n").map((line) => `${prefix} ${line}`);
}

function proposalStatus(
  status: EditorProposalRecord["status"],
  message: string | undefined,
  reviewMode: EditorProposalRecord["reviewMode"],
): string {
  if (message) return message;
  switch (status) {
    case "staged":
      return "Shadow edit staged; the buffer is unchanged.";
    case "unavailable":
      return "Proposal source is unavailable; explicit discard is required.";
    case "recovery":
      return "The accepted buffer revision is awaiting explicit recovery.";
    case "accepting":
      return reviewMode === "acceptance_recovery"
        ? "Finishing daemon acceptance acknowledgement…"
        : "Applying after revision validation…";
    case "rejecting":
      return reviewMode === "acceptance_recovery"
        ? "Discarding the commitment without changing buffer bytes…"
        : "Discarding proposal…";
    case "acknowledgement":
      return "Local review action completed; daemon acknowledgement must be retried.";
    case "accepted":
      return "Applied as one editor undo step.";
    case "rejected":
      return "Proposal discarded.";
    case "stale":
      return "Buffer changed; this proposal is stale.";
    case "error":
      return "Proposal could not be applied.";
  }
}
