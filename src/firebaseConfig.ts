// From `firebase apps:sdkconfig`. These identify the project to Google; they are not secrets.
// Access to data is controlled by sign-in and firestore.rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyBkWcDDl5L12huaBip9ZDLqtc3ICQmYSmo',
  authDomain: 'roman-empire-kt.firebaseapp.com',
  projectId: 'roman-empire-kt',
  storageBucket: 'roman-empire-kt.firebasestorage.app',
  messagingSenderId: '207272432906',
  appId: '1:207272432906:web:158bae78d60bcabb7fd6f3',
};

/** The one account that can change the timeline. Keep in step with isOwner() in firestore.rules. */
export const OWNER_UID = 'VkBC5LjAlKOZ5oCc9liONjukrVE2';
