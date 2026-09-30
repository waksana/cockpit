import type { ComponentType } from 'react';
import type { ModuleComponentProps } from '@cockpit/module-api/frontend';
import {
  MessageBase, SessionStatusBase, AttachmentBase, SettingsBase, ComposerBase, ComposerEditorBase,
  ComposerInputBase, ButtonBase, ManagementHeaderBase, ManagementDetailHeaderBase,
} from '../components/PublicComponentBases';
import { ChatMessageBase, MessageListBase } from '../components/ConversationPresentation';
import { ConversationFrameBase, ConversationHeaderBase, ConversationTranscriptBase } from '../components/ConversationFrame';

export const publicComponentBases: { readonly [Name in keyof ModuleComponentProps]: ComponentType<ModuleComponentProps[Name]> } = {
  message: MessageBase, sessionStatus: SessionStatusBase, attachment: AttachmentBase, settings: SettingsBase,
  chatMessage: ChatMessageBase, messageList: MessageListBase,
  conversationFrame: ConversationFrameBase, conversationHeader: ConversationHeaderBase, conversationTranscript: ConversationTranscriptBase,
  composer: ComposerBase, composerEditor: ComposerEditorBase, composerInput: ComposerInputBase, button: ButtonBase,
  managementHeader: ManagementHeaderBase, managementDetailHeader: ManagementDetailHeaderBase,
};
