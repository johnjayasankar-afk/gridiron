/** The watch party dialog: start a party and invite people by link or QR code, or manage the party this tab is in. */
import { Copy, Share2, Users } from 'lucide-react';
import { useMemo } from 'react';
import { encodeQr, qrSvgPath } from '../../shared/qr';
import { endParty, followHost, leaveParty, startParty } from '../app/usePartySync';
import { copyText, shareLink } from '../lib/share';
import { useLive } from '../state/live';
import { usePartyStore } from '../state/party';
import { useUi } from '../state/ui';
import { IconButton } from './controls';
import { Dialog } from './Dialog';

function QrCode({ text }: { text: string }) {
  const qr = useMemo(() => {
    try {
      return qrSvgPath(encodeQr(text, { ecc: 'M' }), 4);
    } catch {
      return null;
    }
  }, [text]);
  if (!qr) return null;
  return (
    <svg className="party-qr" viewBox={qr.viewBox} role="img" aria-label="QR code for the party link" shapeRendering="crispEdges">
      <rect width="100%" height="100%" fill="#ffffff" />
      <path d={qr.path} fill="#04110b" />
    </svg>
  );
}

export function PartyDialog() {
  const open = useUi((s) => s.dialog === 'party');
  const role = usePartyStore((s) => s.role);
  const id = usePartyStore((s) => s.id);
  const members = usePartyStore((s) => s.members);
  const status = usePartyStore((s) => s.status);
  const error = usePartyStore((s) => s.error);
  const following = usePartyStore((s) => s.following);
  const replay = useLive((s) => s.source.kind === 'replay');
  const close = () => useUi.getState().setDialog(null);
  const link = id ? `${window.location.origin}/?party=${encodeURIComponent(id)}` : '';
  const pending = status === 'connecting' ? ' Connecting…' : status === 'reconnecting' ? ' Reconnecting…' : '';

  const copy = async () => {
    const ok = await copyText(link);
    useUi.getState().showNotice(ok ? 'Party link copied' : 'Could not copy the link');
  };
  const share = async () => {
    const result = await shareLink(link, 'Join my Gridiron watch party');
    if (result !== 'shared') useUi.getState().showNotice(result === 'copied' ? 'Party link copied' : 'Could not share the link');
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Watch party"
      description="Watch together. Everyone with the link follows the host's view as it changes: the page, focused games, a replay and its position, an inspected play and the spoiler delay. A party carries only that view, nothing personal."
      size="sm"
    >
      {status === 'ended' ? (
        <section className="settings-section">
          <p>This watch party has ended.</p>
          <div className="dialog-section-foot">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => leaveParty()}>
              Close the party
            </button>
          </div>
        </section>
      ) : !role ? (
        <section className="settings-section party-start">
          <p className="form-hint">
            Start a party, then share the link or QR code. Guests can explore on their own at any time and return to your view.
            {replay ? ' Guests join this replay session, so everyone shares one replay clock.' : ''}
          </p>
          {error && <p className="banner banner-attention">{error}</p>}
          <button type="button" className="btn btn-primary" disabled={status === 'starting'} onClick={() => void startParty()}>
            <Users size={16} aria-hidden="true" /> {status === 'starting' ? 'Starting…' : 'Start a watch party'}
          </button>
        </section>
      ) : role === 'host' ? (
        <section className="settings-section">
          <p className="party-stat">
            <strong className="mono">{members}</strong>
            <span>
              {members === 1 ? 'person' : 'people'} in the party, including you.{pending}
            </span>
          </p>
          <div className="party-invite">
            <div className="party-link-block">
              <label className="form-label" htmlFor="party-link">
                Invite link
              </label>
              <div className="party-link">
                <input id="party-link" className="party-link-input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
                <IconButton label="Copy the party link" icon={Copy} onClick={() => void copy()} />
                <IconButton label="Share the party link" icon={Share2} onClick={() => void share()} />
              </div>
              <p className="form-hint">Guests see your page as you move around.</p>
            </div>
            <QrCode text={link} />
          </div>
          {error && <p className="banner banner-attention">{error}</p>}
          <div className="dialog-section-foot">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void endParty()}>
              End the party for everyone
            </button>
          </div>
        </section>
      ) : (
        <section className="settings-section">
          <p className="party-stat">
            <strong className="mono">{members}</strong>
            <span>in the party.{pending}</span>
          </p>
          <p>{following ? 'You are following the host.' : 'You are exploring on your own.'}</p>
          {error && <p className="banner banner-attention">{error}</p>}
          <div className="dialog-section-foot">
            {following ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => followHost(false)}>
                Explore on my own
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => followHost(true)}>
                Follow the host
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                leaveParty();
                close();
              }}
            >
              Leave the party
            </button>
          </div>
        </section>
      )}
    </Dialog>
  );
}
