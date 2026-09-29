import type { ComponentType } from 'react';
import type { ModuleComponentProps } from '@cockpit/module-api/frontend';
import {
  MessageBase, SessionStatusBase, AttachmentBase, SettingsBase, ComposerBase, ComposerEditorBase,
  ComposerInputBase, ButtonBase, ManagementHeaderBase, ManagementDetailHeaderBase,
} from '../components/PublicComponentBases';

export const publicComponentBases: { readonly [Name in keyof ModuleComponentProps]: ComponentType<ModuleComponentProps[Name]> } = {
  message: MessageBase, sessionStatus: SessionStatusBase, attachment: AttachmentBase, settings: SettingsBase,
  composer: ComposerBase, composerEditor: ComposerEditorBase, composerInput: ComposerInputBase, button: ButtonBase,
  managementHeader: ManagementHeaderBase, managementDetailHeader: ManagementDetailHeaderBase,
};
