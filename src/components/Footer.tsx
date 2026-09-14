import { useUi } from '../state/ui';

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <p className="footer-credit">
          An independent product by{' '}
          <a href="https://johnjayasankar.com/" target="_blank" rel="noopener">
            John Jayasankar
          </a>
          , part of{' '}
          <a href="https://labs.johnjayasankar.com/" target="_blank" rel="noopener">
            Labs
          </a>
          .
        </p>
        <p className="footer-note">
          Scores and play-by-play come from ESPN&apos;s public but unofficial endpoints and can be delayed, incomplete or unavailable. Fields are schematic. Not affiliated with the NFL, the NCAA or ESPN.{' '}
          <button type="button" className="link-btn" onClick={() => useUi.getState().setDialog('help')}>
            Data and sources
          </button>
        </p>
      </div>
    </footer>
  );
}
