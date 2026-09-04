import React from 'react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import FormPendampingan from './pages/FormPendampingan';

function App() {
  return (
    <>
      <FormPendampingan />
      <SpeedInsights />
    </>
  );
}

export default App;
