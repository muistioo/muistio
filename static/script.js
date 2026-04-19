// script.js

const app = {
    db: { tasks: [], companies: [] },
    state: {
        currentlyEditingId: null,
        sortable: null,
        isDragLocked: true,
        activeTimers: {} // Tarkkailee käynnissä olevia ajastimia
    },

    // --- ALUSTUS ---
    async init() {
        this.theme.init();
        this.addEventListeners();
        try {
            const response = await fetch('/api/init');
            if (!response.ok) {
                if (response.status === 401) {
                    window.location.reload(); // Ohjaa kirjautumissivulle, jos ei kirjautunut
                    return;
                }
                throw new Error(`Failed to fetch initial data: ${response.statusText}`);
            }
            this.db = await response.json();
            this.ui.renderCompanies();
            this.ui.renderTasks();
            this.initSortable();
            this.startTimerUpdater(); // Käynnistä ajastimen päivitys
        } catch (error) {
            console.error("Initialization failed:", error);
            alert("Tietojen lataus epäonnistui. Varmista, että palvelin on käynnissä ja yritä ladata sivu uudelleen.");
        }
    },

    addEventListeners() {
        document.getElementById('companySelector').addEventListener('change', e => this.handlers.onCompanyChange(e.target.value));
        document.getElementById('searchBox').addEventListener('keyup', () => this.ui.renderTasks());
        document.getElementById('prioFilter').addEventListener('change', () => this.ui.renderTasks());
        document.getElementById('sortOrder').addEventListener('change', () => this.ui.renderTasks());
        document.getElementById('drag-lock-btn').addEventListener('click', () => this.toggleDragLock());
    },

    // --- TIETOJENKÄSITTELY (API) ---
    async addTask() {
        const content = document.getElementById('taskIn').value.trim();
        if (!content) return;
        const payload = {
            content,
            company: document.getElementById('companySelector').value,
            due_date: document.getElementById('dateIn').value || null,
            priority: document.getElementById('prioIn').value
        };
        const newTask = await this.api.post('/api/tasks', payload);
        this.db.tasks.push(newTask);
        document.getElementById('taskIn').value = '';
        document.getElementById('dateIn').value = '';
        this.ui.renderTasks();
    },

    async submitEdit() {
        // Muunna minuutit sekunneiksi
        const timeSpentMinutes = parseFloat(document.getElementById('editTimeSpentMinutes').value);
        const timeSpentSeconds = isNaN(timeSpentMinutes) ? 0 : Math.round(timeSpentMinutes * 60);

        const data = {
            content: document.getElementById('editContent').value,
            company: document.getElementById('editCompany').value,
            priority: document.getElementById('editPrio').value,
            due_date: document.getElementById('editDate').value || null,
            time_spent: timeSpentSeconds // Päivitä aika sekunneissa
        };
        const updatedTask = await this.api.put(`/api/tasks/${this.state.currentlyEditingId}`, data);
        const index = this.db.tasks.findIndex(t => t.id === this.state.currentlyEditingId);
        if (index !== -1) {
            this.db.tasks[index] = updatedTask;
            // Varmista, että timer_started_at säilyy, jos ajastin oli käynnissä
            const originalTask = this.db.tasks.find(t => t.id === this.state.currentlyEditingId);
            if (originalTask && originalTask.timer_started_at && !updatedTask.timer_started_at) {
                this.db.tasks[index].timer_started_at = originalTask.timer_started_at;
            }
        }
        this.ui.closeModals();
        this.ui.renderTasks();
    },

    async deleteTask(taskId) {
        if (confirm("Haluatko varmasti poistaa tämän tehtävän pysyvästi?")) {
            await this.api.delete(`/api/tasks/${taskId}`);
            this.db.tasks = this.db.tasks.filter(t => t.id !== taskId);
            this.ui.renderTasks();
        }
    },
    
    async toggleDone(taskId) {
        const updatedTask = await this.api.patch(`/api/tasks/${taskId}`, { action: 'toggle_done' });
        const index = this.db.tasks.findIndex(t => t.id === taskId);
        if (index !== -1) this.db.tasks[index] = updatedTask;
        this.ui.renderTasks();
    },

    async toggleTimer(taskId) {
        const task = this.db.tasks.find(t => t.id === taskId);
        if (!task) return;
        const action = task.timer_started_at ? 'stop_timer' : 'start_timer';
        const updatedTask = await this.api.patch(`/api/tasks/${taskId}`, { action });
        const index = this.db.tasks.findIndex(t => t.id === taskId);
        if (index !== -1) this.db.tasks[index] = updatedTask;
        this.ui.renderTasks();
    },

    async submitCompany() {
        const name = document.getElementById('newCompIn').value.trim();
        if (!name) return;
        const updatedCompanies = await this.api.post('/api/companies', { name });
        this.db.companies = updatedCompanies;
        this.ui.renderCompanies();
        document.getElementById('companySelector').value = name;
        document.getElementById('newCompIn').value = '';
        this.ui.closeModals();
        this.ui.renderTasks();
    },

    async deleteCompany() {
        const companyToDelete = document.getElementById('companySelector').value;
        if (companyToDelete === "Yleinen") {
            alert("Oletusyritystä 'Yleinen' ei voi poistaa.");
            return;
        }
        if (confirm(`Haluatko varmasti poistaa yrityksen "${companyToDelete}"? Kaikki sen tehtävät siirretään 'Yleinen'-yritykseen.`)) {
            try {
                const response = await this.api.delete(`/api/companies/${companyToDelete}`);
                if (response && response.new_companies) {
                    this.db.companies = response.new_companies;
                    // Päivitä myös tehtävät paikallisesti
                    this.db.tasks.forEach(task => {
                        if (task.company === companyToDelete) {
                            task.company = 'Yleinen';
                        }
                    });
                    this.ui.renderCompanies();
                    document.getElementById('companySelector').value = 'Yleinen'; // Valitse Yleinen
                    this.ui.renderTasks();
                }
            } catch (error) {
                console.error("Error deleting company:", error);
                alert("Yrityksen poisto epäonnistui.");
            }
        }
    },
    
    // --- KÄYTTÖLIITTYMÄN HALLINTA (UI) ---
    ui: {
        renderCompanies() {
            const sel = document.getElementById('companySelector');
            const editSel = document.getElementById('editCompany');
            const html = app.db.companies.map(c => `<option value="${c}">${c}</option>`).join('');
            sel.innerHTML = html + `<option value="NEW_COMPANY" style="font-weight:bold;color:var(--accent-blue);">+ Lisää uusi yritys...</option>`;
            editSel.innerHTML = html;
        },

        renderTasks() {
            const taskListEl = document.getElementById('taskList');
            taskListEl.innerHTML = '';
            
            const filteredAndSortedTasks = this.getVisibleTasks();
            
            filteredAndSortedTasks.forEach(task => {
                const taskEl = this.createTaskElement(task);
                taskListEl.appendChild(taskEl);
            });

            this.updateStats(filteredAndSortedTasks);
        },

        createTaskElement(task) {
            const el = document.createElement('li');
            el.className = `task-item ${task.done ? 'done-style' : ''}`;
            el.dataset.id = task.id;

            const isRunning = !!task.timer_started_at;
            let timeSpent = task.time_spent || 0;
            if (isRunning) {
                const startTime = new Date(task.timer_started_at);
                const now = new Date();
                timeSpent += (now - startTime) / 1000;
            }

            el.innerHTML = `
                <div class="prio-line" style="background:var(--prio-${task.priority || 'medium'})"></div>
                <div class="item-checkbox-wrapper">
                    <input type="checkbox" onclick="event.stopPropagation(); app.toggleDone(${task.id})" ${task.done ? 'checked' : ''}>
                </div>
                <div class="item-main-content" onclick="app.ui.openEditModal(${task.id})">
                    <div class="item-title">${task.content}</div>
                    <div class="item-meta">Lisätty: ${new Date(task.created_at).toLocaleString('fi-FI').slice(0, -3)}</div>
                </div>
                <div class="item-time-tracker" id="time-${task.id}">${app.helpers.formatTime(timeSpent)}</div>
                <div class="action-buttons-wrapper">
                    <button class="action-btn timer-btn ${isRunning ? 'running' : ''}" onclick="event.stopPropagation(); app.toggleTimer(${task.id})" title="Käynnistä/pysäytä ajastin">
                        ${isRunning 
                            ? `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12"></rect></svg>`
                            : `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`
                        }
                    </button>
                    <button class="action-btn delete" onclick="event.stopPropagation(); app.deleteTask(${task.id})" title="Poista tehtävä">✕</button>
                </div>
            `;
            return el;
        },

        getVisibleTasks() {
            const company = document.getElementById('companySelector').value;
            const search = document.getElementById('searchBox').value.toLowerCase();
            const prio = document.getElementById('prioFilter').value;
            const sort = document.getElementById('sortOrder').value;

            let tasks = app.db.tasks.filter(t => 
                (t.company || 'Yleinen') === company &&
                t.content.toLowerCase().includes(search) &&
                (prio === 'all' || t.priority === prio)
            );
            
            if (sort !== 'manual') {
                const prioValues = { high: 3, medium: 2, low: 1 };
                tasks.sort((a, b) => {
                    switch (sort) {
                        case 'newest': return new Date(b.created_at) - new Date(a.created_at);
                        case 'oldest': return new Date(a.created_at) - new Date(b.created_at);
                        case 'due_asc': return (a.due_date ? new Date(a.due_date) : Infinity) - (b.due_date ? new Date(b.due_date) : Infinity);
                        case 'prio_desc': return (prioValues[b.priority] || 0) - (prioValues[a.priority] || 0);
                        default: return 0;
                    }
                });
            }
            return tasks;
        },

        updateStats(visibleTasks) {
            document.getElementById('statOpen').innerText = visibleTasks.filter(t => !t.done).length;
            document.getElementById('statUrgent').innerText = visibleTasks.filter(t => t.priority === 'high' && !t.done).length;
        },

        openEditModal(taskId) {
            const task = app.db.tasks.find(t => t.id === taskId);
            if (!task) return;
            app.state.currentlyEditingId = taskId;
            document.getElementById('editContent').value = task.content;
            document.getElementById('editCompany').value = task.company || 'Yleinen';
            document.getElementById('editPrio').value = task.priority || 'medium';
            document.getElementById('editDate').value = task.due_date ? task.due_date.slice(0, 16) : '';
            // Muunna time_spent sekunneista minuuteiksi muokkausta varten
            document.getElementById('editTimeSpentMinutes').value = Math.round((task.time_spent || 0) / 60);
            document.getElementById('editModal').style.display = 'flex';
        },
        
        closeModals() {
            document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
        },
    },
    
    // --- APUFUNKTIOT ---
    handlers: {
        onCompanyChange(value) {
            if (value === "NEW_COMPANY") {
                document.getElementById('companyModal').style.display = 'flex';
                // Palautetaan valinta ensimmäiseen yritykseen, jotta "Lisää uusi" ei jää valituksi.
                if (app.db.companies.length > 0) {
                    document.getElementById('companySelector').value = app.db.companies[0];
                }
            } else {
                app.ui.renderTasks();
            }
        },
    },

    helpers: {
        formatTime(totalSeconds) {
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = Math.floor(totalSeconds % 60);
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        },
    },
    
    // --- TEEMA ---
    theme: {
        init() {
            const savedTheme = localStorage.getItem('theme') || 'light';
            this.set(savedTheme);
            document.getElementById('theme-toggle').addEventListener('click', () => {
                const newTheme = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
                this.set(newTheme);
            });
        },
        set(themeName) {
            document.body.classList.toggle('dark-mode', themeName === 'dark');
            localStorage.setItem('theme', themeName);
        }
    },
    
    // --- JÄRJESTELY (DRAG & DROP) ---
    initSortable() {
        const list = document.getElementById('taskList');
        this.state.sortable = new Sortable(list, {
            animation: 150,
            ghostClass: 'sortable-ghost',
            disabled: this.state.isDragLocked,
            onEnd: async (evt) => {
                const orderedIds = Array.from(evt.to.children).map(item => parseInt(item.dataset.id));
                app.db.tasks.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
                await app.api.post('/api/tasks/reorder', { ordered_ids: orderedIds });
            },
        });
    },

    toggleDragLock() {
        this.state.isDragLocked = !this.state.isDragLocked;
        this.state.sortable.option('disabled', this.state.isDragLocked);
        document.getElementById('drag-lock-btn').classList.toggle('locked', this.state.isDragLocked);
        if (!this.state.isDragLocked) {
            document.getElementById('sortOrder').value = 'manual';
            this.ui.renderTasks(); // Renderöi tehtävät uudelleen, jotta manuaalinen järjestys näkyy
        }
    },

    // --- AJASTIMEN PÄIVITTÄJÄ ---
    startTimerUpdater() {
        setInterval(() => {
            app.db.tasks.forEach(task => {
                if (task.timer_started_at) {
                    const timeEl = document.getElementById(`time-${task.id}`);
                    if (timeEl) {
                        const startTime = new Date(task.timer_started_at);
                        const now = new Date();
                        const runningTime = (now - startTime) / 1000;
                        timeEl.textContent = app.helpers.formatTime(task.time_spent + runningTime);
                    }
                }
            });
        }, 1000);
    },

    // --- KALENTERIVIENTI ---
    generateICS(tasks, filename) {
        let icsContent = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//K-Pro Task Manager//NONSGML v1.0//EN"];
        tasks.forEach(task => {
            if (!task.due_date) return;
            const eventDate = new Date(task.due_date);
            if (isNaN(eventDate.getTime())) return;
            // Muoto: YYYYMMDDTHHMMSSZ
            const icsDate = eventDate.toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
            icsContent.push("BEGIN:VEVENT", `UID:${task.id}@k-pro-app.com`, `DTSTAMP:${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z"}`, `DTSTART:${icsDate}`, `SUMMARY:${task.content}`, "END:VEVENT");
        });
        icsContent.push("END:VCALENDAR");
        const blob = new Blob([icsContent.join("\n")], { type: 'text/calendar;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${filename.replace(/ /g, "_")}.ics`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
    },

    exportSingle(title, date) {
        if (!date || date === 'null' || date === 'undefined') return alert("Aseta tehtävälle eräpäivä, jotta siitä voi luoda kalenterimerkinnän.");
        this.generateICS([{ content: title, due_date: date, id: 'single_' + Date.now() }], title);
    },

    exportCompanyTasks() {
        const company = document.getElementById('companySelector').value;
        const tasks = this.db.tasks.filter(t => (t.company || 'Yleinen') === company && t.due_date);
        if (tasks.length === 0) return alert("Valitulla yrityksellä ei ole yhtään tehtävää, jolla olisi eräpäivä.");
        this.generateICS(tasks, company + "_tasks");
    },

    // --- API-WRAPPER ---
    api: {
        async request(endpoint, method, body = null) {
            const options = {
                method,
                headers: { 'Content-Type': 'application/json' },
            };
            if (body) options.body = JSON.stringify(body);
            const response = await fetch(endpoint, options);
            if (!response.ok) {
                const error = new Error(`HTTP error! status: ${response.status}`);
                error.response = response;
                throw error;
            }
            return response.status === 204 ? null : response.json();
        },
        post(endpoint, body) { return this.request(endpoint, 'POST', body); },
        put(endpoint, body) { return this.request(endpoint, 'PUT', body); },
        patch(endpoint, body) { return this.request(endpoint, 'PATCH', body); },
        delete(endpoint) { return this.request(endpoint, 'DELETE'); },
    },
};

// Käynnistä sovellus
app.init();
