import { createHash } from 'node:crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

export type ChecksumAlgorithm = 'sha1' | 'sha256' | 'sha384' | 'sha512';

export interface ApiTarget {
  /** e.g. https://scalelite.example.org/bigbluebutton/api */
  apiUrl: string;
  secret: string;
  checksum: ChecksumAlgorithm;
  /** Forward proxy for the API calls of the controller. */
  proxy?: { server: string; username?: string | undefined; password?: string | undefined };
}

export interface MeetingInfo {
  running: boolean;
  participantCount: number;
  moderatorCount: number;
  listenerCount: number;
  voiceParticipantCount: number;
  videoCount: number;
}

export function signQuery(call: string, query: string, secret: string, algorithm: ChecksumAlgorithm): string {
  return createHash(algorithm).update(call + query + secret).digest('hex');
}

export function encodeQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export function xmlTag(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`).exec(xml)?.[1];
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export type PresentationSource = { url: string } | { name: string; base64: string };

export function presentationXml(source: PresentationSource): string {
  const document =
    'url' in source
      ? `<document url="${escapeXml(source.url)}"/>`
      : `<document name="${escapeXml(source.name)}">${source.base64}</document>`;
  return `<modules><module name="presentation">${document}</module></modules>`;
}

export class BbbClient {
  private readonly dispatcher?: ProxyAgent;
  private readonly base: string;

  constructor(private readonly target: ApiTarget) {
    this.base = target.apiUrl.replace(/\/+$/, '');
    const { proxy } = target;
    if (proxy) {
      const credentials = proxy.username ? `${proxy.username}:${proxy.password ?? ''}` : undefined;
      this.dispatcher = new ProxyAgent({
        uri: proxy.server,
        ...(credentials ? { token: `Basic ${Buffer.from(credentials).toString('base64')}` } : {}),
      });
    }
  }

  signedUrl(call: string, params: Record<string, string>): string {
    const query = encodeQuery(params);
    const checksum = signQuery(call, query, this.target.secret, this.target.checksum);
    return `${this.base}/${call}?${query}${query ? '&' : ''}checksum=${checksum}`;
  }

  private async call(call: string, params: Record<string, string>, body?: string): Promise<string> {
    const res = await undiciFetch(this.signedUrl(call, params), {
      method: body ? 'POST' : 'GET',
      ...(body ? { body, headers: { 'content-type': 'application/xml' } } : {}),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const xml = await res.text();
    if (!res.ok && res.status !== 404) throw new Error(`${call}: HTTP ${res.status}`);
    return xml;
  }

  async create(params: Record<string, string>, presentation?: PresentationSource): Promise<void> {
    const body = presentation ? presentationXml(presentation) : undefined;
    const xml = await this.call('create', params, body);
    if (xmlTag(xml, 'returncode') !== 'SUCCESS') {
      throw new Error(`create fehlgeschlagen: ${xmlTag(xml, 'messageKey')} ${xmlTag(xml, 'message')}`);
    }
  }

  async getMeetingInfo(meetingID: string): Promise<MeetingInfo | undefined> {
    const xml = await this.call('getMeetingInfo', { meetingID });
    if (xmlTag(xml, 'returncode') !== 'SUCCESS') return undefined;
    const n = (tag: string) => Number(xmlTag(xml, tag) ?? 0);
    return {
      running: xmlTag(xml, 'running') === 'true',
      participantCount: n('participantCount'),
      moderatorCount: n('moderatorCount'),
      listenerCount: n('listenerCount'),
      voiceParticipantCount: n('voiceParticipantCount'),
      videoCount: n('videoCount'),
    };
  }

  async end(meetingID: string, password: string): Promise<void> {
    await this.call('end', { meetingID, password });
  }
}
