/**
 * Keeps push alerts in step with this browser's choices. When favorite teams or
 * alert kinds change, the server is told shortly after. Removing the last
 * favorite team turns push alerts off, and so does a subscription the browser
 * dropped on its own.
 */
import { useEffect } from 'react';
import { PUSH_TEAM_KEY } from '../../shared/push';
import { disablePush, syncPush } from '../data/push';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';

export function usePushSync() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sent = '';
    const turnOff = () => usePrefs.getState().set({ push: { ...usePrefs.getState().push, enabled: false } });

    const run = async () => {
      const { push, favorites } = usePrefs.getState();
      if (!push.enabled) {
        sent = '';
        return;
      }
      const teams = favorites.map((f) => f.key).filter((key) => PUSH_TEAM_KEY.test(key));
      const choice = JSON.stringify([teams, push.kinds]);
      if (choice === sent) return;
      sent = choice;
      if (!teams.length) {
        await disablePush();
        turnOff();
        useUi.getState().showNotice('Push alerts are off: no favorite teams are left to follow');
        return;
      }
      const result = await syncPush(teams, push.kinds);
      if (result === 'off') turnOff();
      // A failed update is tried again with the next change.
      else if (result !== 'synced') sent = '';
    };

    const off = usePrefs.subscribe((s, p) => {
      if (s.favorites === p.favorites && s.push === p.push) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), 1_000);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
