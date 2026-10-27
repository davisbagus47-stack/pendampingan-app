import React from 'react';
import FormPendampingan from './pages/FormPendampingan';
import Web3Login from './components/Web3Login';

function App() {
  const [session, setSession] = React.useState(null);
  return session ? <FormPendampingan walletAddress={session.address} /> : <Web3Login onAuthenticated={setSession} />;
}

export default App;
