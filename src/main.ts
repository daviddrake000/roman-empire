import './styles.css';

// Firebase Hosting serves the app on both <project>.web.app and <project>.firebaseapp.com.
// Sign-in redirects only work reliably (Safari, home-screen apps) on the domain that hosts
// the sign-in handler, which is firebaseapp.com, so send everyone there.
if (location.hostname.endsWith('.web.app')) {
  location.replace(location.href.replace('.web.app', '.firebaseapp.com'));
} else {
  // Imported after the check so Firebase doesn't start up on a page that's leaving
  import('./app');
}
