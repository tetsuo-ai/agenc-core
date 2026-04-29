import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommandCatalogEntry, VoiceState, VoiceMode } from '../../types';
import { VoiceButton } from './VoiceButton';

interface ChatInputProps {
  onSend: (content: string, attachments?: File[]) => void;
  onStop?: () => void;
  isGenerating?: boolean;
  disabled?: boolean;
  voiceState?: VoiceState;
  voiceMode?: VoiceMode;
  onVoiceToggle?: () => void;
  onPushToTalkStart?: () => void;
  onPushToTalkStop?: () => void;
  commands?: CommandCatalogEntry[];
}

interface SlashCommandOption {
  name: string;
  description: string;
  args?: string;
  category?: string;
  aliases?: readonly string[];
  deprecatedAliases?: readonly string[];
  available?: boolean;
  availabilityReason?: string;
  effectiveProfile?: string;
  heldBackBy?: string;
}

function getSlashQuery(value: string): string | null {
  if (!value.startsWith('/')) return null;
  if (value.includes('\n')) return null;
  const spaceIndex = value.indexOf(' ');
  if (spaceIndex !== -1) return null;
  return value.slice(1).toLowerCase();
}

export function ChatInput({
  onSend,
  onStop,
  isGenerating = false,
  disabled,
  voiceState = 'inactive',
  voiceMode = 'vad',
  onVoiceToggle,
  onPushToTalkStart,
  onPushToTalkStop,
  commands = [],
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashQuery = useMemo(() => getSlashQuery(value), [value]);
  const availableCommands = useMemo<SlashCommandOption[]>(
    () =>
      commands.map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        ...(cmd.args ? { args: cmd.args } : {}),
        ...(cmd.category ? { category: cmd.category } : {}),
        ...(Array.isArray(cmd.aliases) && cmd.aliases.length > 0 ? { aliases: cmd.aliases } : {}),
        ...(Array.isArray(cmd.deprecatedAliases) && cmd.deprecatedAliases.length > 0
          ? { deprecatedAliases: cmd.deprecatedAliases }
          : {}),
        ...(typeof cmd.available === 'boolean' ? { available: cmd.available } : {}),
        ...(cmd.availabilityReason ? { availabilityReason: cmd.availabilityReason } : {}),
        ...(cmd.effectiveProfile ? { effectiveProfile: cmd.effectiveProfile } : {}),
        ...(cmd.heldBackBy ? { heldBackBy: cmd.heldBackBy } : {}),
      })),
    [commands],
  );
  const visibleCommands = useMemo(() => {
    if (slashQuery === null) return [];
    if (!slashQuery) return availableCommands;
    return availableCommands.filter((cmd) => {
      if (cmd.name.startsWith(slashQuery)) {
        return true;
      }
      return [...(cmd.aliases ?? []), ...(cmd.deprecatedAliases ?? [])].some((alias) =>
        alias.startsWith(slashQuery),
      );
    });
  }, [availableCommands, slashQuery]);
  const showCommandMenu = visibleCommands.length > 0;

  useEffect(() => {
    setActiveCommandIndex(0);
  }, [slashQuery]);

  const focusComposer = useCallback(() => {
    const focus = () => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const cursor = el.value.length;
      el.setSelectionRange(cursor, cursor);
    };
    focus();
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(focus);
    }
  }, []);

  useEffect(() => {
    if (disabled) return;
    const active = document.activeElement;
    const activeIsTextInput =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement ||
      (active instanceof HTMLElement && active.isContentEditable);
    if (activeIsTextInput && active !== textareaRef.current) return;
    focusComposer();
  }, [disabled, focusComposer]);

  const applyCommand = useCallback((cmd: SlashCommandOption) => {
    if (cmd.available === false) return;
    const nextValue = `/${cmd.name} `;
    setValue(nextValue);
    setActiveCommandIndex(0);
    focusComposer();
  }, [focusComposer]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && attachments.length === 0) return;
    if (disabled) return;
    onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    setValue('');
    setAttachments([]);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    focusComposer();
  }, [attachments, disabled, focusComposer, onSend, value]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      setAttachments((prev) => [...prev, ...Array.from(files)]);
    }
    e.target.value = '';
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showCommandMenu) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActiveCommandIndex((prev) => (prev + 1) % visibleCommands.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActiveCommandIndex((prev) => (prev - 1 + visibleCommands.length) % visibleCommands.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const selected = visibleCommands[activeCommandIndex];
          if (selected) applyCommand(selected);
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [activeCommandIndex, applyCommand, handleSubmit, showCommandMenu, visibleCommands],
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  }, []);

  return (
    <div className="px-3 pb-3 md:px-6 md:pb-4">
      <div className="border border-bbs-border bg-bbs-surface overflow-visible relative">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
          accept="image/*,.pdf,.txt,.md,.json,.csv,.doc,.docx"
        />

        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-2">
            {attachments.map((file, i) => (
              <span
                key={`${file.name}-${i}`}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs text-bbs-cyan border border-bbs-border"
              >
                [{file.name}]
                <button
                  onClick={() => removeAttachment(i)}
                  className="text-bbs-gray hover:text-bbs-red transition-colors"
                >
                  x
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Prompt line */}
        <div className="flex items-start gap-2 px-3 py-2">
          <span className="text-bbs-purple font-bold shrink-0 mt-0.5">{'>'}</span>
          <textarea
            ref={textareaRef}
            data-chat-composer="true"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder="Enter command..."
            disabled={disabled}
            rows={1}
            className="flex-1 text-sm text-bbs-white resize-none focus:outline-none placeholder:text-bbs-gray disabled:opacity-50 bg-transparent leading-relaxed caret-bbs-purple font-mono"
          />
        </div>

        {/* Slash command menu */}
        {showCommandMenu && (
          <div
            data-testid="slash-command-menu"
            className="mx-3 mb-2 border border-bbs-border bg-bbs-dark overflow-hidden"
          >
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-bbs-gray border-b border-bbs-border">
              Commands
            </div>
            <div className="max-h-56 overflow-y-auto">
              {visibleCommands.map((cmd, idx) => (
                <button
                  key={cmd.name}
                  type="button"
                  disabled={cmd.available === false}
                  data-testid={`slash-command-${cmd.name}`}
                  onClick={() => applyCommand(cmd)}
                  className={`w-full text-left px-3 py-2 transition-colors text-xs ${
                    cmd.available === false
                      ? 'text-bbs-gray/60 cursor-not-allowed'
                      : idx === activeCommandIndex
                        ? 'bg-bbs-surface text-bbs-white'
                        : 'text-bbs-lightgray hover:bg-bbs-surface/50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-bbs-purple font-mono">{'>'} /{cmd.name}</span>
                    {cmd.args && <span className="text-bbs-gray font-mono">{cmd.args}</span>}
                    {cmd.category && (
                      <span className="border border-bbs-border px-1 py-0 text-[10px] uppercase tracking-wide text-bbs-cyan">
                        {cmd.category}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-bbs-gray">
                    {cmd.description}
                    {cmd.available === false && cmd.availabilityReason
                      ? ` - ${cmd.availabilityReason}`
                      : ''}
                  </div>
                  {cmd.aliases && cmd.aliases.length > 0 && (
                    <div className="mt-1 text-[11px] text-bbs-gray">
                      aliases: {cmd.aliases.map((alias) => `/${alias}`).join(', ')}
                    </div>
                  )}
                  {(cmd.deprecatedAliases && cmd.deprecatedAliases.length > 0) && (
                    <div className="mt-1 text-[11px] text-bbs-gray">
                      deprecated: {cmd.deprecatedAliases.map((alias) => `/${alias}`).join(', ')}
                    </div>
                  )}
                  {(cmd.effectiveProfile || cmd.heldBackBy) && (
                    <div className="mt-1 text-[11px] text-bbs-gray">
                      {cmd.effectiveProfile ? `profile: ${cmd.effectiveProfile}` : 'profile: default'}
                      {cmd.heldBackBy ? ` - held by ${cmd.heldBackBy}` : ''}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Bottom row: attach, mic, send/stop */}
        <div className="flex items-center justify-end gap-2 px-3 pb-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="text-xs text-bbs-gray hover:text-bbs-cyan transition-colors disabled:opacity-40"
            title="Attach file"
          >
            [FILE]
          </button>

          {onVoiceToggle && (
            <VoiceButton
              voiceState={voiceState}
              mode={voiceMode}
              onToggle={onVoiceToggle}
              onPushToTalkStart={onPushToTalkStart}
              onPushToTalkStop={onPushToTalkStop}
              disabled={disabled}
            />
          )}

          {isGenerating ? (
            <button
              onClick={onStop}
              className="text-xs text-bbs-red hover:text-bbs-white transition-colors font-bold"
              title="Stop generation"
            >
              [STOP]
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={disabled || (!value.trim() && attachments.length === 0)}
              className="text-xs text-bbs-purple hover:text-bbs-white transition-colors font-bold disabled:opacity-40 disabled:cursor-not-allowed"
              title="Send message"
            >
              [SEND]
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
