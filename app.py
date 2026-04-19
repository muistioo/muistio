import json
import os
import datetime
from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.secret_key = os.urandom(24).hex()
DATA_FILE = 'data.json'

# Salasanan hallinta ympäristömuuttujalla
APP_PASSWORD = os.getenv("APP_PASSWORD", "servimus730285")
PASSWORD_HASH = generate_password_hash(APP_PASSWORD)

def load_db():
    """Lataa tietokannan tiedostosta ja varmistaa sen rakenteen."""
    default = {"tasks": [], "companies": ["Yleinen"]}
    if not os.path.exists(DATA_FILE):
        return default
    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            if not isinstance(data, dict) or 'tasks' not in data or 'companies' not in data:
                return default
            # Varmistetaan, että kaikilla tehtävillä on company-kenttä sekä ajastinkentät
            for task in data.get('tasks', []):
                task.setdefault('company', 'Yleinen')
                task.setdefault('time_spent', 0)
                task.setdefault('timer_started_at', None)
            return data
    except (json.JSONDecodeError, IOError):
        return default

def save_db(data):
    """Tallentaa tietokannan tiedostoon."""
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4, ensure_ascii=False, sort_keys=True)

def is_logged():
    """Tarkistaa, onko käyttäjä kirjautunut sisään."""
    return session.get('logged_in')

@app.route('/')
def index():
    return render_template('login.html') if not is_logged() else render_template('index.html')

@app.route('/login', methods=['POST'])
def login():
    password_attempt = request.json.get('password', '')
    if check_password_hash(PASSWORD_HASH, password_attempt):
        session['logged_in'] = True
        return jsonify({"success": True})
    return jsonify({"success": False}), 401

@app.route('/logout')
def logout():
    session.pop('logged_in', None)
    return redirect(url_for('index'))

@app.route('/api/init')
def init_data():
    if not is_logged(): return jsonify({"error": "Unauthorized"}), 401
    return jsonify(load_db())

@app.route('/api/companies', methods=['POST'])
def add_company():
    if not is_logged(): return jsonify({"error": "Unauthorized"}), 401
    db = load_db()
    name = request.json.get('name', '').strip()
    if name and name not in db['companies']:
        db['companies'].append(name)
        save_db(db)
    return jsonify(db['companies'])

@app.route('/api/companies/<string:company_name>', methods=['DELETE'])
def delete_company(company_name):
    if not is_logged(): return jsonify({"error": "Unauthorized"}), 401
    if company_name == "Yleinen":
        return jsonify({"error": "Cannot delete default company 'Yleinen'"}), 400

    db = load_db()
    if company_name in db['companies']:
        db['companies'].remove(company_name)
        # Siirrä kaikki poistettavaan yritykseen liittyvät tehtävät "Yleinen"-yritykseen
        for task in db['tasks']:
            if task.get('company') == company_name:
                task['company'] = 'Yleinen'
        save_db(db)
        return jsonify({"status": "Company deleted", "new_companies": db['companies']}), 200
    return jsonify({"error": "Company not found"}), 404


@app.route('/api/tasks', methods=['POST'])
def add_task():
    if not is_logged(): return jsonify({"error": "Unauthorized"}), 401
    db = load_db()
    data = request.json
    new_task = {
        'id': int(datetime.datetime.now().timestamp() * 1000),
        'content': data.get('content'),
        'company': data.get('company', 'Yleinen'),
        'due_date': data.get('due_date'),
        'priority': data.get('priority', 'medium'),
        'done': False,
        'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'time_spent': 0,
        'timer_started_at': None
    }
    db['tasks'].append(new_task)
    save_db(db)
    return jsonify(new_task), 201

@app.route('/api/tasks/reorder', methods=['POST'])
def reorder_tasks():
    if not is_logged(): return jsonify({"error": "Unauthorized"}), 401
    db = load_db()
    ordered_ids = request.json.get('ordered_ids', [])
    
    task_map = {task['id']: task for task in db['tasks']}
    new_task_list = [task_map[tid] for tid in ordered_ids if tid in task_map]
    
    # Lisätään loput tehtävät, joita ei ollut järjestetyssä listassa, niiden alkuperäisessä järjestyksessä
    existing_ids = set(ordered_ids)
    remaining_tasks = [task for task in db['tasks'] if task['id'] not in existing_ids]
    
    db['tasks'] = new_task_list + remaining_tasks
    save_db(db)
    return jsonify({"status": "success"}), 200

@app.route('/api/tasks/<int:task_id>', methods=['PUT', 'PATCH', 'DELETE'])
def handle_task(task_id):
    if not is_logged(): return jsonify({"error": "Unauthorized"}), 401
    db = load_db()
    task = next((t for t in db['tasks'] if t['id'] == task_id), None)
    if not task:
        return jsonify({"error": "Task not found"}), 404

    if request.method == 'DELETE':
        db['tasks'] = [t for t in db['tasks'] if t['id'] != task_id]
        save_db(db)
        return '', 204

    if request.method == 'PUT':
        data = request.json
        task.update({
            'content': data.get('content', task['content']),
            'company': data.get('company', task.get('company', 'Yleinen')), 
            'due_date': data.get('due_date', task['due_date']),
            'priority': data.get('priority', task['priority']),
            'time_spent': data.get('time_spent', task.get('time_spent', 0)) # Salli time_spentin päivitys
        })

    if request.method == 'PATCH':
        data = request.json
        action = data.get('action')
        
        if action == 'toggle_done':
            task['done'] = not task.get('done', False)
        
        elif action == 'start_timer':
            if not task.get('timer_started_at'):
                task['timer_started_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()

        elif action == 'stop_timer':
            if task.get('timer_started_at'):
                start_time = datetime.datetime.fromisoformat(task['timer_started_at'])
                end_time = datetime.datetime.now(datetime.timezone.utc)
                elapsed_seconds = (end_time - start_time).total_seconds()
                task['time_spent'] = task.get('time_spent', 0) + elapsed_seconds
                task['timer_started_at'] = None
    
    save_db(db)
    return jsonify(task)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=os.getenv("FLASK_DEBUG", "False").lower() in ["true", "1"])

