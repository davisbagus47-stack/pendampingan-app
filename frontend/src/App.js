import React from 'react';
import FormPendampingan from './pages/FormPendampingan';
import Web3Login from './components/Web3Login';

const LOGIN_ROUTE = '#/login';
const FORM_ROUTE = '#/form';

function currentRoute() {
  return window.location.hash === FORM_ROUTE ? 'form' : 'login';
}

function App() {
  const [route, setRoute] = React.useState(currentRoute);
  const [session, setSession] = React.useState(null);

  React.useEffect(() => {
    const handleRouteChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', handleRouteChange);
    if (!window.location.hash) window.history.replaceState(null, '', LOGIN_ROUTE);
    return () => window.removeEventListener('hashchange', handleRouteChange);
  }, []);

  React.useEffect(() => {
    if (route === 'form' && !session) window.location.hash = LOGIN_ROUTE;
  }, [route, session]);

  const handleAuthenticated = (nextSession) => {
    setSession(nextSession);
    window.location.hash = FORM_ROUTE;
  };

  const handleLogout = () => {
    setSession(null);
    window.location.hash = LOGIN_ROUTE;
  };

  if (route === 'form' && session) {
    return <FormPendampingan session={session} onLogout={handleLogout} />;
  }

  return <Web3Login onAuthenticated={handleAuthenticated} />;
}

export default App;
