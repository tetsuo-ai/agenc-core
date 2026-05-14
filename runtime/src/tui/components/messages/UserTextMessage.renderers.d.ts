import type { ComponentType } from 'react';

type Renderer = ComponentType<any>;

export const InterruptedByUser: Renderer;
export const MessageResponse: Renderer;
export const UserAgentNotificationMessage: Renderer;
export const UserBashInputMessage: Renderer;
export const UserBashOutputMessage: Renderer;
export const UserCommandMessage: Renderer;
export const UserLocalCommandOutputMessage: Renderer;
export const UserMemoryInputMessage: Renderer;
export const UserPlanMessage: Renderer;
export const UserPromptMessage: Renderer;
export const UserResourceUpdateMessage: Renderer;
export const UserTeammateMessage: Renderer;
