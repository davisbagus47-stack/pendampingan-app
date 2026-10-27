import { render, screen } from '@testing-library/react';
import App from './App';

jest.mock('axios', () => ({
  get: jest.fn(() => Promise.resolve({ data: { data: [] } })),
  post: jest.fn(),
}));

test('renders the separate login page', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /masuk dengan wallet/i })).toBeInTheDocument();
  expect(window.location.hash).toBe('#/login');
});
