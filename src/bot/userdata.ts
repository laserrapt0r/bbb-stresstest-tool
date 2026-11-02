import type { Role } from '../shared/scenario.js';

/** Join parameters do the work where they can: the fewer UI clicks, the steadier the load. */
export function joinUserdata(role: Role): Record<string, string> {
  const data: Record<string, string> = {
    'userdata-bbb_show_session_details_on_join': 'false',
    'userdata-bbb_auto_join_audio': String(role.audio !== 'none'),
    'userdata-bbb_skip_check_audio': 'true',
    'userdata-bbb_skip_video_preview': 'true',
  };
  if (role.audio === 'listen') data['userdata-bbb_force_listen_only'] = 'true';
  if (role.audio === 'microphone') data['userdata-bbb_listen_only_mode'] = 'false';
  if (role.webcam) data['userdata-bbb_auto_share_webcam'] = 'true';
  return data;
}
