// Standalone artifact views use a tab-local token, like the main application.
(() => {
  let token = '';
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<form method="dialog"><h2>Operator session</h2>
    <label>Access token <input name="token" type="password" autocomplete="off"></label>
    <p>The token stays in this tab until you sign out or reload.</p>
    <button value="cancel">Cancel</button><button value="out">Sign out</button>
    <button value="in">Sign in</button></form>`;
  document.body.append(dialog);
  const button = document.createElement('button');
  button.className = 'button';
  button.textContent = 'Operator session';
  button.onclick = () => { dialog.querySelector('input').value = ''; dialog.showModal(); };
  document.querySelector('.hero-actions').append(button);
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'out') { token = ''; location.reload(); }
    if (dialog.returnValue === 'in') {
      token = dialog.querySelector('input').value.trim();
      dialog.querySelector('input').value = '';
      window.dispatchEvent(new Event('horizon-session-change'));
    }
  });
  window.HorizonSession = {
    async fetch(url) {
      const response = await fetch(url, {cache: 'no-store', signal: AbortSignal.timeout(120000),
        headers: token ? {Authorization: `Bearer ${token}`} : {}});
      if (response.status === 401) throw new Error('Open Operator session to authenticate.');
      if (!response.ok) throw new Error(`Request returned HTTP ${response.status}`);
      return response;
    },
  };
  document.addEventListener('click', async (event) => {
    const link = event.target.closest('a[href*="/data/horizon/latest/"]');
    if (!link) return;
    event.preventDefault();
    try {
      if (!window.HorizonSession.runId) throw new Error('Load a version before downloading artifacts.');
      const path = link.href.split('/data/horizon/latest/')[1];
      const response = await window.HorizonSession.fetch(`/artifacts/${encodeURIComponent(window.HorizonSession.runId)}/${path}`);
      const url = URL.createObjectURL(await response.blob());
      const download = document.createElement('a');
      download.href = url; download.download = path.split('/').pop(); download.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      document.querySelector('#scope-note').textContent = error.message;
    }
  });
})();
