export const BASE_URL = '';
function unavailable(): never { throw new Error('Review has no native backend or upload transport.'); }
export const EVENTS_URL = 'about:invalid#review-no-events';
export const CHAT_STREAM_URL = 'about:invalid#review-no-stream';
export const intentUrl = unavailable;
export const uploadUrl = unavailable;
