/** Disposable website; no external accounts or operator browser data. */
export function startBrowserFixture() {
  return Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/login' && request.method === 'POST') {
        await request.text()
        return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': 'fixture_login=yes; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400' } })
      }
      if (url.pathname === '/redirect-private') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
      const loggedIn = request.headers.get('cookie')?.includes('fixture_login=yes')
      return new Response(`<!doctype html><html><head><title>Browser fixture</title></head><body>
        <h1>${loggedIn ? 'Authenticated fixture' : 'Guest fixture'}</h1>
        <form action="/login" method="post"><label>Username <input name="username"></label><label>Password <input name="password" type="password"></label><button>Log in</button></form>
        <label>Message <input id="message" aria-label="Message"></label>
        <button id="copy" onclick="document.querySelector('#result').textContent=document.querySelector('#message').value">Copy message</button><p id="result"></p>
        <label>Choice <select aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
        <label><input type="checkbox" aria-label="Accept">Accept</label>
        <a href="/next">Next page</a><div style="height:1500px"></div><p>Bottom of fixture</p>
        <script>localStorage.setItem('fixture-state','persistent');document.body.dataset.executed='yes'</script>
        </body></html>`, { headers: { 'content-type': 'text/html' } })
    },
  })
}
