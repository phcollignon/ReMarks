const LOG = document.getElementById('log');
function log(msg) { 
    LOG.innerText += `> ${msg}\n`; 
    LOG.scrollTop = LOG.scrollHeight;
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.sync.get(['user', 'repo', 'token', 'selectedPaths'], (items) => {
        if(items.user) document.getElementById('ghUsername').value = items.user;
        if(items.repo) document.getElementById('ghRepo').value = items.repo;
        if(items.token) document.getElementById('ghToken').value = items.token;
        window.selectedPaths = items.selectedPaths || [];
    });
});

document.getElementById('saveBtn').addEventListener('click', () => {
    const creds = {
        user: document.getElementById('ghUsername').value,
        repo: document.getElementById('ghRepo').value,
        token: document.getElementById('ghToken').value
    };
    chrome.storage.sync.set(creds, () => log('Credentials Saved.'));
});

// --- SELECTIVE SYNC UI ---
document.getElementById('loadRemoteBtn').addEventListener('click', async () => {
    log('Fetching directory structure...');
    const creds = await getCreds();
    if(!creds.token) return log('Error: Missing Token');

    try {
        const remoteContent = await fetchFileFromGit(creds, 'bookmarks.json');
        
        if(!remoteContent || remoteContent.trim().length === 0) {
            return log('ℹ️ Repo is empty or file is blank. Please Sync first.');
        }
        
        let tree;
        try {
            tree = JSON.parse(remoteContent);
        } catch (e) {
            return log('⚠️ Remote file is not valid JSON. Cannot load folders.');
        }

        const container = document.getElementById('folderTree');
        container.style.display = 'block';
        container.innerHTML = buildCheckboxTree(tree);
        
        // Restore previous checks
        window.selectedPaths.forEach(pathStr => {
            const chk = document.getElementById(`chk-${pathStr}`);
            if(chk) chk.checked = true;
        });

        log('Select folders to import.');
    } catch(e) {
        console.error(e);
        log('Error: ' + e.message);
    }
});

// Helper: recursive HTML builder for the UI
function buildCheckboxTree(nodes, parentPath = []) {
    let html = '<ul style="list-style:none; padding-left:20px; margin:0;">';
    
    for (const node of nodes) {
        if (node.id === '0') {
            html += buildCheckboxTree(node.children, []);
            continue;
        }

        if (node.children) {
            const currentPath = [...parentPath, node.title];
            const pathStr = currentPath.join('###'); 
            
            // USING SAFE HTML ENTITY: &#x1F4C1; (📁)
            html += `
            <li style="margin-top:4px;">
                <details open>
                    <summary style="cursor:pointer; display:flex; align-items:center;">
                        <input type="checkbox" id="chk-${pathStr}" class="folder-check" data-path="${pathStr}">
                        <span>&#x1F4C1; <b>${node.title}</b></span>
                    </summary>
                    ${buildCheckboxTree(node.children, currentPath)}
                </details>
            </li>`;
        }
    }
    html += '</ul>';
    return html;
}

// Recursive Checkbox Logic (Checking parent selects children)
document.getElementById('folderTree').addEventListener('change', (e) => {
    if(e.target.classList.contains('folder-check')) {
        const isChecked = e.target.checked;
        const parentPath = e.target.dataset.path;

        const allChecks = document.querySelectorAll('.folder-check');
        allChecks.forEach(chk => {
            if (chk.dataset.path.startsWith(parentPath + '###')) {
                chk.checked = isChecked;
            }
        });

        const finalChecked = document.querySelectorAll('.folder-check:checked');
        window.selectedPaths = Array.from(finalChecked).map(c => c.dataset.path);
        chrome.storage.sync.set({ selectedPaths: window.selectedPaths });
    }
});


// --- MAIN SYNC LOGIC ---
document.getElementById('syncBtn').addEventListener('click', async () => {
    log('Starting Sync...');
    const creds = await getCreds();
    if(!creds.token) return log('Error: No token saved.');

    try {
        log('Fetching remote bookmarks...');
        const remoteContent = await fetchFileFromGit(creds, 'bookmarks.json');
        
        if (remoteContent && remoteContent.trim().length > 0) {
            try {
                log('Merging remote changes...');
                const remoteTree = JSON.parse(remoteContent);
                await mergeRemoteToLocal(remoteTree, window.selectedPaths);
            } catch (jsonErr) {
                log('⚠️ Remote file invalid/corrupt. Overwriting with local data...');
            }
        } else {
            log('ℹ️ First Sync: Uploading local bookmarks...');
        }

        log('Generating updated files...');
        const tree = await chrome.bookmarks.getTree();
        
        const jsonStr = JSON.stringify(tree, null, 2);
        const htmlStr = generateNetscapeHTML(tree);
        const readmeStr = generatePrettyReadme(tree);

        log('Pushing to GitHub...');
        await pushFileToGit(creds, 'bookmarks.json', jsonStr);
        await pushFileToGit(creds, 'bookmarks.html', htmlStr);
        await pushFileToGit(creds, 'README.md', readmeStr);
        
        log('✅ SYNC COMPLETE!');

    } catch (e) {
        console.error(e);
        log(`Error: ${e.message}`);
    }
});

// --- MERGE LOGIC ---
async function mergeRemoteToLocal(remoteTree, allowedPaths = []) {
    const flatRemote = [];
    flatten(remoteTree, [], flatRemote);
    let added = 0;
    let skipped = 0;

    for (const item of flatRemote) {
        if (!item.url) continue;

        // Selective Import Filter
        if (allowedPaths && allowedPaths.length > 0) {
            const itemPathStr = item.path.join('###');
            const isAllowed = allowedPaths.some(allowed => itemPathStr.startsWith(allowed));
            if (!isAllowed) { skipped++; continue; }
        }

        const exists = await chrome.bookmarks.search({ url: item.url });
        if (exists.length === 0) {
            const parentId = await ensurePath(item.path);
            await chrome.bookmarks.create({ parentId, title: item.title, url: item.url });
            added++;
        }
    }
    log(`Merge: +${added} added, ${skipped} filtered.`);
}

// --- PATH FIXER ---
async function ensurePath(pathArr) {
    let pid = '1'; 
    let start = 0;

    if (pathArr.length > 0) {
        const rootName = pathArr[0].toLowerCase();
        // Map common names to Chrome's internal Root IDs
        if (rootName === 'bookmarks bar' || rootName === 'barre de favoris') { pid = '1'; start = 1; } 
        else if (rootName === 'other bookmarks' || rootName === 'autres favoris') { pid = '2'; start = 1; }
        else if (rootName === 'mobile bookmarks') { pid = '3'; start = 1; }
    }
    
    for (let i=start; i<pathArr.length; i++) {
        const children = await chrome.bookmarks.getChildren(pid);
        const found = children.find(c => !c.url && c.title.toLowerCase() === pathArr[i].toLowerCase());
        if (found) { pid = found.id; } 
        else {
            const newF = await chrome.bookmarks.create({ parentId: pid, title: pathArr[i] });
            pid = newF.id;
        }
    }
    return pid;
}

// --- UTILITIES (FIXED FLATTEN FUNCTION) ---
function flatten(nodes, path, list) {
    for (const n of nodes) {
        if (n.id === '0') { 
            flatten(n.children, path, list); 
            continue; 
        }
        
        // 1. If it's a bookmark, add it to the list using the CURRENT path (parent)
        if (n.url) {
            list.push({ title: n.title, url: n.url, path: path }); 
        }

        // 2. If it's a folder, recurse deeper using a NEW path
        if (n.children) {
            const newPath = [...path, n.title];
            flatten(n.children, newPath, list);
        }
    }
}

// --- GENERATORS (ROBUST ENTITIES) ---
function generatePrettyReadme(tree) {
    let md = "# 📑 ReMarks: Synced Bookmarks\n\n### 📂 Interactive Bookmark Explorer\nClick folders to expand.\n\n<ul>\n";
    function traverseHTMLTree(nodes) {
        let html = "";
        for (const node of nodes) {
            if (node.id === '0') { html += traverseHTMLTree(node.children); continue; }
            const safeTitle = node.title || 'Untitled';
            if (node.url) {
                // Link Icon: &#x1F517; (🔗)
                html += `<li>&#x1F517; <a href="${node.url}">${safeTitle}</a></li>\n`;
            } else if (node.children) {
                const childrenHtml = traverseHTMLTree(node.children);
                if (childrenHtml.trim().length > 0 || true) { 
                    // Folder Icon: &#x1F4C1; (📁)
                    html += `<li><details><summary><strong>&#x1F4C1; ${safeTitle}</strong></summary><ul>${childrenHtml}</ul></details></li>\n`;
                }
            }
        }
        return html;
    }
    md += traverseHTMLTree(tree);
    md += "</ul>\n\n---\n*Last Updated: " + new Date().toLocaleString() + "*";
    return md;
}

function generateNetscapeHTML(tree) {
    let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n`;
    function traverseHTML(nodes) {
        let out = "";
        for (const node of nodes) {
            if(node.id === '0') { out += traverseHTML(node.children); continue; }
            if (node.url) {
                out += `    <DT><A HREF="${node.url}">${node.title}</A>\n`;
            } else if (node.children) {
                out += `    <DT><H3>${node.title}</H3>\n    <DL><p>\n`;
                out += traverseHTML(node.children);
                out += `    </DL><p>\n`;
            }
        }
        return out;
    }
    html += traverseHTML(tree);
    html += "</DL><p>";
    return html;
}

// --- GIT API (TEXTENCODER/DECODER FOR UTF-8) ---
async function getCreds() { return new Promise(r => chrome.storage.sync.get(['user', 'repo', 'token'], r)); }

async function fetchFileFromGit({user, repo, token}, filename) {
    const url = `https://api.github.com/repos/${user}/${repo}/contents/${filename}`;
    const res = await fetch(url, { headers: { 'Authorization': `token ${token}` } });
    
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API Error: ${res.status}`);

    const json = await res.json();
    
    // Proper UTF-8 Decoding
    const binaryString = atob(json.content.replace(/\n/g, ''));
    const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
}

async function pushFileToGit({user, repo, token}, filename, content) {
    const url = `https://api.github.com/repos/${user}/${repo}/contents/${filename}`;
    let sha = null;
    
    const check = await fetch(url, { headers: { 'Authorization': `token ${token}` } });
    if (check.ok) { 
        const d = await check.json(); 
        sha = d.sha; 
    }
    
    // Proper UTF-8 Encoding
    const bytes = new TextEncoder().encode(content);
    const binaryString = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
    const contentEncoded = btoa(binaryString);

    const body = { message: "Sync " + new Date().toISOString().split('T')[0], content: contentEncoded };
    if (sha) body.sha = sha;
    
    const pushRes = await fetch(url, { 
        method: 'PUT', 
        headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json' }, 
        body: JSON.stringify(body) 
    });
    
    if (!pushRes.ok) throw new Error(`Push Failed: ${pushRes.status}`);
}