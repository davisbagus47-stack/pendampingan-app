import React from 'react';
import { JsonRpcProvider } from 'ethers';
import FormPendampingan from './pages/FormPendampingan';
import Web3Login from './components/Web3Login';

const LOGIN_ROUTE = '#/login';
const FORM_ROUTE = '#/form';
const RPC_URL = process.env.REACT_APP_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const provider = new JsonRpcProvider(RPC_URL, 11155111, { staticNetwork: true });

function currentRoute() {
  return window.location.hash === FORM_ROUTE ? 'form' : 'login';
}

function FundedForm({ session, onLogout }) {
  const [allowed, setAllowed] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const balanceWei = await provider.getBalance(session.address);
        if (cancelled) return;
        if (balanceWei > 0n) {
          setAllowed(true);
          return;
        }
      } catch {
        if (cancelled) return;
      }
      if (!cancelled) {
        setAllowed(false);
        onLogout('Saldo Sepolia wallet masih 0 atau belum dapat diverifikasi. Form belum dapat dibuka.');
      }
    })();
    return () => { cancelled = true; };
  }, [onLogout, session.address]);

  if (allowed !== true) return <main><p>Memeriksa saldo Sepolia sebelum membuka form...</p></main>;
  return <FormPendampingan session={session} onLogout={onLogout} />;
}

function App() {
  const [route, setRoute] = React.useState(currentRoute);
  const [session, setSession] = React.useState(null);
  const [loginNotice, setLoginNotice] = React.useState('');

  React.useEffect(() => {
    const handleRouteChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', handleRouteChange);
    if (!window.location.hash) window.history.replaceState(null, '', LOGIN_ROUTE);
    return () => window.removeEventListener('hashchange', handleRouteChange);
  }, []);

  React.useEffect(() => {
    if (route === 'form' && !session) {
      setRoute('login');
      window.location.hash = LOGIN_ROUTE;
    }
  }, [route, session]);

  const handleAuthenticated = (nextSession) => {
    setSession(nextSession);
    setLoginNotice('');
    setRoute('form');
    window.location.hash = FORM_ROUTE;
  };

  const handleLogout = React.useCallback((message = '') => {
    setSession(null);
    setLoginNotice(message);
    setRoute('login');
    window.location.hash = LOGIN_ROUTE;
  }, []);

  if (route === 'form' && session) {
    return <FundedForm session={session} onLogout={handleLogout} />;
  }

  return <Web3Login onAuthenticated={handleAuthenticated} initialNotice={loginNotice} />;
}

export default App;
