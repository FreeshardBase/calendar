test('unauthenticated API request returns 401 Unauthorized', async ({ request }) => {
  const response = await request.get('/api/calendars', {
    headers: {
      'X-Test-User-Id': 'unauthenticated'
    }
  });
  expect(response.status()).toBe(401);
});
