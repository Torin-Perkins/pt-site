from flask import Flask, render_template, request, redirect, url_for, flash
from flask_mail import Mail, Message
import os
from dotenv import load_dotenv
import pandas as pd
import re

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'your-secret-key-change-this')

# Email configuration
app.config['MAIL_SERVER'] = os.getenv('MAIL_SERVER', 'smtp.gmail.com')
app.config['MAIL_PORT'] = int(os.getenv('MAIL_PORT', 587))
app.config['MAIL_USE_TLS'] = True
app.config['MAIL_USERNAME'] = os.getenv('MAIL_USERNAME')
app.config['MAIL_PASSWORD'] = os.getenv('MAIL_PASSWORD')
app.config['MAIL_DEFAULT_SENDER'] = os.getenv('MAIL_USERNAME')
app.config['RECIPIENT_EMAIL'] = os.getenv('RECIPIENT_EMAIL')

mail = Mail(app)

# Goals I specialize in (shown on the home page and in the inquiry form)
GOALS = [
    {
        'slug': 'wedding',
        'icon': '💍',
        'title': 'Wedding Prep',
        'tagline': 'Look and feel your best on the big day.',
        'description': 'A countdown plan built around your wedding date. We work backward from the day so you peak for the photos without crash dieting, and you keep the results for the honeymoon and after.',
    },
    {
        'slug': 'weight-loss',
        'icon': '📉',
        'title': 'Weight Loss',
        'tagline': 'Lose the fat, keep the muscle, keep it off.',
        'description': 'No 500-calorie diets and no gimmicks. A sustainable deficit, strength training that protects your metabolism, and habits that fit a full-time job and a family.',
    },
    {
        'slug': 'bodybuilding',
        'icon': '🏆',
        'title': 'Bodybuilding',
        'tagline': 'Build a physique you are proud of.',
        'description': 'Hypertrophy programming, smart progression and precise nutrition, whether you want to step on stage or simply carry more muscle into your 40s, 50s and beyond.',
    },
]

GOAL_CHOICES = [g['title'] for g in GOALS] + ['General health & strength', 'Not sure yet']

# Plan data
PLANS = {
    'one-time-nutrition': {
        'title': 'Nutrition Blueprint',
        'slug': 'one-time-nutrition',
        'tagline': 'One-time plan',
        'description': 'A personalized nutrition plan built around your goal, your schedule and the foods you actually like to eat.',
        'best_for': 'Self-starters who already train and want their nutrition dialed in.',
        'features': [
            'Calorie and macronutrient targets for your goal',
            'Customized meal plan that fits a busy week',
            'Shopping list and simple meal-prep guide',
            'Evidence-based supplement recommendations',
            'Yours to keep for good',
        ],
        'featured': False,
    },
    'monthly-nutrition': {
        'title': 'Nutrition Coaching',
        'slug': 'monthly-nutrition',
        'tagline': 'Monthly support',
        'description': 'Your nutrition plan, adjusted every month as your body, schedule and goals change.',
        'best_for': 'Steady weight loss or a lean-out before an event.',
        'features': [
            'Everything in the Nutrition Blueprint',
            'Monthly plan revisions based on your progress',
            'Progress tracking (weight, measurements, photos)',
            'Recipe ideas and meal-prep tips',
            'Email support between updates',
        ],
        'featured': False,
    },
    'monthly-coaching': {
        'title': 'Complete Online Coaching',
        'slug': 'monthly-coaching',
        'tagline': 'Most popular',
        'description': 'Training and nutrition coaching together, with weekly accountability. My most complete option and the fastest path to real results.',
        'best_for': 'Wedding countdowns, serious body transformations and bodybuilding.',
        'features': [
            'Custom training program for your goal and equipment',
            'Monthly nutrition plans and adjustments',
            'Weekly check-ins and progress reviews',
            'Form review on your lift videos',
            'Direct messaging support',
            'Joint-friendly exercise swaps when life happens',
        ],
        'featured': True,
    },
}

def load_exercises():
    df = pd.read_csv('exercise_list.csv')
    ex_list = []
    for _, row in df.iterrows():
        ex_list.append({
            'name': row['name'], 
            'muscle': row['muscle_groups'],
            'keywords': [k.strip().lower() for k in str(row['keywords']).split(',')],
            'youtube': fix_youtube_url(row['video'])
        })
    return ex_list


@app.route('/')
def home():
    return render_template('home.html', plans=PLANS, goals=GOALS)

@app.route('/about')
def about():
    return render_template('about.html')

@app.route('/plan/<plan_slug>')
def plan(plan_slug):
    if plan_slug not in PLANS:
        return redirect(url_for('home'))
    return render_template('plan.html', plan=PLANS[plan_slug], goal_choices=GOAL_CHOICES)

@app.route('/submit-inquiry', methods=['POST'])
def submit_inquiry():
    try:
        name = request.form.get('name')
        email = request.form.get('email')
        phone = request.form.get('phone')
        plan_title = request.form.get('plan_title')
        goal = request.form.get('goal', '')
        age_range = request.form.get('age_range', '')
        event_date = request.form.get('event_date', '')
        message = request.form.get('message', '')
        
        # Create email message
        email_body = f"""
New inquiry received:

Name: {name}
Email: {email}
Phone: {phone}
Plan: {plan_title}
Primary goal: {goal}
Age range: {age_range}
Event / wedding date: {event_date or 'n/a'}

Message:
{message}

---
Sent from the Toro Fitness website
        """
        
        msg = Message(
            subject=f'New Inquiry: {plan_title}',
            recipients=[app.config['RECIPIENT_EMAIL']],
            body=email_body
        )
        
        mail.send(msg)
        flash('Thank you! Your inquiry has been submitted successfully. I will get back to you soon.', 'success')
    except Exception as e:
        print(f"Error sending email: {e}")
        flash('There was an error submitting your inquiry. Please email me directly.', 'error')
    
    return redirect(request.referrer or url_for('home'))

@app.context_processor
def inject_year():
    from datetime import date
    return {'current_year': date.today().year}

@app.route('/thank-you')
def thank_you():
    return render_template('thank_you.html')

def smart_search(exercises, query):
    if not query:
        return exercises
    # Split query into words, ignore extra whitespace
    query_words = re.split(r'\s+', query.strip().lower())
    results = []
    for ex in exercises:
        searchable = [
            ex['name'].lower(),
            ex['muscle'].lower(),
            ' '.join(ex['keywords'])
        ]
        # If any query word appears in any searchable field, keep it
        if any(qw in field for qw in query_words for field in searchable):
            results.append(ex)
    return results

def fix_youtube_url(url):
    # If standard embed, pass through
    if "/embed/" in url:
        return url
    # If shorts, convert to embed
    shorts_pattern = r'youtube.com/shorts/([\w-]+)'
    match = re.search(shorts_pattern, url)
    if match:
        vid_id = match.group(1)
        return f'https://www.youtube.com/embed/{vid_id}'
    # If watch?v= format
    if 'watch?v=' in url:
        vid_id = url.split('watch?v=')[1]
        return f'https://www.youtube.com/embed/{vid_id}'
    # Return as-is if unrecognized
    return url

@app.route('/cheat_sheet')
def cheat_sheet():
    query = request.args.get('q', '')
    exercises = load_exercises()
    results = smart_search(exercises, query)
    return render_template('cheat_sheet.html', exercises=results, q=query)

if __name__ == '__main__':
    app.run(host='0.0.0.0')
