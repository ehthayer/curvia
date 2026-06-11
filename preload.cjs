/* Preload bridge: the ONLY surface the sandboxed renderer can touch.
 * Read calls + the one verified write (set active profile), fulfilled by the
 * main process via fellow-client.mjs. No Node, no credentials/tokens in the page.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fellowAPI', {
  profiles: () => ipcRenderer.invoke('fellow:profiles'),
  device: () => ipcRenderer.invoke('fellow:device'),
  setActive: (profileId) => ipcRenderer.invoke('fellow:setActive', profileId),
  createProfile: (dto) => ipcRenderer.invoke('fellow:createProfile', dto),
  updateProfile: (pid, dto) => ipcRenderer.invoke('fellow:updateProfile', pid, dto),
  deleteProfile: (pid) => ipcRenderer.invoke('fellow:deleteProfile', pid),
  searchRoasters: (q) => ipcRenderer.invoke('fellow:roasters', q),
  authStatus: () => ipcRenderer.invoke('fellow:authStatus'),
  signIn: (email, password) => ipcRenderer.invoke('fellow:signIn', email, password),
  signOut: () => ipcRenderer.invoke('fellow:signOut'),
});
