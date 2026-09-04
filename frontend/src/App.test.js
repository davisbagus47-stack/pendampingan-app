import { render } from '@testing-library/react';
import App from './App';

// Mock Speed Insights to avoid issues in tests
jest.mock('@vercel/speed-insights/react');

test('renders App component without crashing', () => {
  const { container } = render(<App />);
  expect(container).toBeInTheDocument();
});
