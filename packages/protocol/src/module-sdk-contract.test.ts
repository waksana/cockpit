import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_MODULE_EVENT_BYTES as SDK_MAX_MODULE_EVENT_BYTES,
  MCP_INVOCATION_META_KEY as SDK_MCP_INVOCATION_META_KEY,
  type NativeAttachment as SdkNativeAttachment,
  type NativeAttachmentDescriptor as SdkNativeAttachmentDescriptor,
  type NativeChatEvent as SdkNativeChatEvent,
  type ServerEvent as SdkServerEvent,
  type SessionMeta as SdkSessionMeta,
} from '@waksana/cockpit-module-sdk';
import {
  MAX_MODULE_EVENT_BYTES,
  MCP_INVOCATION_META_KEY,
  type NativeAttachment,
  type NativeAttachmentDescriptor,
  type NativeChatEvent,
  type ServerEvent,
  type SessionMeta,
} from './index.ts';

type Assert<Type extends true> = Type;
type SameKeys<Left, Right> =
  Exclude<keyof Left, keyof Right> extends never
    ? Exclude<keyof Right, keyof Left> extends never ? true : false
    : false;
type _SessionKeys = Assert<SameKeys<SessionMeta, SdkSessionMeta>>;
type _HostSessionFitsSdk = Assert<SessionMeta extends SdkSessionMeta ? true : false>;
type _SdkSessionFitsHost = Assert<SdkSessionMeta extends SessionMeta ? true : false>;
type _HostEventFitsSdk = Assert<ServerEvent extends SdkServerEvent ? true : false>;
type _SdkEventFitsHost = Assert<SdkServerEvent extends ServerEvent ? true : false>;
type _HostAttachmentFitsSdk = Assert<NativeAttachment extends SdkNativeAttachment ? true : false>;
type _SdkAttachmentFitsHost = Assert<SdkNativeAttachment extends NativeAttachment ? true : false>;
type _HostDescriptorFitsSdk = Assert<NativeAttachmentDescriptor extends SdkNativeAttachmentDescriptor ? true : false>;
type _SdkDescriptorFitsHost = Assert<SdkNativeAttachmentDescriptor extends NativeAttachmentDescriptor ? true : false>;
type _HostChatEventFitsSdk = Assert<NativeChatEvent extends SdkNativeChatEvent ? true : false>;
type _SdkChatEventFitsHost = Assert<SdkNativeChatEvent extends NativeChatEvent ? true : false>;

test('module SDK runtime constants are the protocol constants', () => {
  assert.equal(SDK_MAX_MODULE_EVENT_BYTES, MAX_MODULE_EVENT_BYTES);
  assert.equal(SDK_MCP_INVOCATION_META_KEY, MCP_INVOCATION_META_KEY);
});
