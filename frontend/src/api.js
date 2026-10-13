// small helper to call the backend with the login token

// The login token is kept only in memory (a normal variable).
// After a page refresh it is gone, so the user has to log in again.
let token = null

export function setToken(newToken) {
  token = newToken
}

export async function api(url, method, body) {
  const options = {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json' }
  }
  if (token) {
    options.headers.Authorization = 'Bearer ' + token
  }
  if (body !== undefined) {
    options.body = JSON.stringify(body)
  }
  const res = await fetch('/api' + url, options)
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  // token not valid anymore (e.g. database was reset) -> reload = back to the login page
  if (res.status === 401 && token) {
    window.location.reload()
  }
  if (!res.ok) {
    const message = data && data.error ? data.error : 'Request failed (' + res.status + ')'
    throw new Error(message)
  }
  return data
}

export function formatTime(value) {
  if (!value) return ''
  return new Date(value).toLocaleString()
}
