from flask import Flask, render_template, request, redirect, url_for, flash, abort, Response, send_from_directory
from datetime import date
from flask_mail import Mail, Message
import os
from dotenv import load_dotenv
import pandas as pd
import re

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'your-secret-key-change-this')
# Cache static files (CSS, JS, images) in browsers for a week
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 60 * 60 * 24 * 7
# Public address of the site, used for canonical URLs, the sitemap and social previews.
# Set SITE_URL on your host (e.g. https://www.yourdomain.com). Falls back to the request host.
SITE_URL = os.getenv('SITE_URL', '').rstrip('/')

# Email configuration
app.config['MAIL_SERVER'] = os.getenv('MAIL_SERVER', 'smtp.gmail.com')
app.config['MAIL_PORT'] = int(os.getenv('MAIL_PORT', 587))
app.config['MAIL_USE_TLS'] = True
app.config['MAIL_USERNAME'] = os.getenv('MAIL_USERNAME')
app.config['MAIL_PASSWORD'] = os.getenv('MAIL_PASSWORD')
app.config['MAIL_DEFAULT_SENDER'] = os.getenv('MAIL_USERNAME')
app.config['RECIPIENT_EMAIL'] = os.getenv('RECIPIENT_EMAIL')

mail = Mail(app)

# Goals I specialize in. Each one also gets its own landing page for SEO.
GOALS = [
    {
        'slug': 'wedding-prep',
        'icon': '💍',
        'title': 'Wedding Prep',
        'tagline': 'Look and feel your best on the big day.',
        'description': 'A countdown plan built around your wedding date. We work backward from the day so you peak for the photos without crash dieting, and you keep the results for the honeymoon and after.',
        'seo_title': 'Wedding Workout & Diet Plan for Brides and Grooms',
        'meta_description': 'Online wedding prep coaching for brides and grooms in their 30s to 60s. A countdown training and nutrition plan built around your wedding date, with no crash diets.',
        'h1': 'Wedding prep coaching for brides and grooms',
        'intro': 'You have a date on the calendar and you want to feel confident in the dress, the suit and every photo. My wedding prep coaching gives you a training and nutrition plan that counts down to your big day, so you arrive lean, strong and energized instead of hungry and exhausted.',
        'sections': [
            ('Built backward from your wedding date', 'We start with your date and plan in phases: a building phase to add muscle tone and strength, a focused fat-loss phase, and a final taper so you look and feel your best in the last two weeks. The more lead time you give us, the more we can do without extreme dieting.'),
            ('Training for the photos you care about', 'Arms, shoulders and back for a strapless dress. Chest, shoulders and posture for a fitted suit. Your program prioritizes what you want to see, built on full-body strength training that also helps you stand taller and move better.'),
            ('Nutrition that survives wedding planning', 'Tastings, showers, bachelor and bachelorette parties: real life does not stop. You get flexible calorie and protein targets, simple meal templates and a plan for events, so one dinner out never derails your progress.'),
            ('Results that last past the honeymoon', 'Crash diets rebound the moment the wedding is over. Because we build sustainable habits and keep your metabolism healthy, you keep the progress for the honeymoon and the years after.'),
        ],
        'who_for': ['Brides and grooms with 3 to 12 months until the wedding', 'Wedding party members who want to look sharp in photos', 'Couples who want to train toward the day together', 'Anyone who has tried crash diets before and wants a smarter approach'],
        'faqs': [
            ('How far before my wedding should I start?', 'Ideally 6 to 12 months out, which allows a gradual, sustainable approach. Three months is still plenty of time to make visible progress. If you have less, we focus on what will make the biggest difference by the day.'),
            ('Will I have to cut carbs or follow a crash diet?', 'No. You will eat real food, including carbs, in a moderate calorie deficit with high protein. That protects your energy, mood and muscle while you lose fat.'),
            ('Can my partner and I train together?', 'Yes. Couples can each get an individual plan built around a shared schedule, which makes accountability much easier.'),
        ],
        'plan': 'monthly-coaching',
    },
    {
        'slug': 'weight-loss',
        'icon': '📉',
        'title': 'Weight Loss',
        'tagline': 'Lose the fat, keep the muscle, keep it off.',
        'description': 'No 500-calorie diets and no gimmicks. A sustainable deficit, strength training that protects your metabolism, and habits that fit a full-time job and a family.',
        'seo_title': 'Weight Loss Coach for Adults Over 30, 40 and 50',
        'meta_description': 'Online weight loss coaching for adults 30 to 60. Strength training and sustainable nutrition that help you lose fat, keep muscle and keep the weight off for good.',
        'h1': 'Weight loss coaching for adults 30 to 60',
        'intro': 'If you have lost the same 20 pounds more than once, the problem was never your willpower. It was the plan. My weight loss coaching combines strength training, a sustainable calorie deficit and real accountability so the weight comes off and stays off, even with a career, a family and a schedule that never slows down.',
        'sections': [
            ('Why weight loss gets harder after 30', 'As we age we naturally lose muscle, sleep and stress get harder to manage, and the habits that worked at 22 stop working. The fix is not eating less and less. It is building and keeping muscle, eating enough protein and managing recovery, so your metabolism works for you.'),
            ('Strength training first, cardio second', 'Lifting weights tells your body to keep muscle while you lose fat, so you end up leaner and stronger instead of just smaller. Walking and cardio support the plan, but they are not the whole plan.'),
            ('No crash diets, ever', 'I know from personal experience how dangerous extreme dieting is. You get calorie and protein targets that fit your life, foods you actually enjoy and a pace of loss you can sustain for months, not days.'),
            ('Accountability that keeps you going', 'Weekly check-ins, progress tracking and plan adjustments mean you are never guessing. When progress stalls, we change the plan rather than blaming you.'),
        ],
        'who_for': ['Adults in their 30s, 40s, 50s and 60s with 10 to 100+ pounds to lose', 'Busy professionals and parents with limited time to train', 'People who have tried diets before and regained the weight', 'Anyone who wants to feel stronger, not just weigh less'],
        'faqs': [
            ('How fast will I lose weight?', 'Most people do well losing around 0.5 to 1 percent of their body weight per week. That pace protects muscle and is much easier to sustain than rapid weight loss.'),
            ('Do I need a gym membership?', 'A gym gives you the most options, but I can build an effective program around home equipment such as dumbbells and bands.'),
            ('I have bad knees or back pain. Can I still train?', 'Yes. Your program is built around your history, with exercise swaps that keep you training safely. For medical conditions, check with your doctor before starting any new program.'),
        ],
        'plan': 'monthly-coaching',
    },
    {
        'slug': 'bodybuilding',
        'icon': '🏆',
        'title': 'Bodybuilding',
        'tagline': 'Build a physique you are proud of.',
        'description': 'Hypertrophy programming, smart progression and precise nutrition, whether you want to step on stage or simply carry more muscle into your 40s, 50s and beyond.',
        'seo_title': 'Online Bodybuilding Coach & Contest Prep, 30+',
        'meta_description': 'Online bodybuilding coaching from a competitive bodybuilder. Hypertrophy training, bulking and cutting nutrition, and contest prep for lifters in their 30s to 60s.',
        'h1': 'Online bodybuilding and muscle-building coaching',
        'intro': 'Whether you want to step on stage for the first time or simply build the most muscular, aesthetic physique of your life, bodybuilding coaching gives you a hypertrophy program and nutrition plan designed by someone who has competed. And yes, you can build serious muscle in your 30s, 40s, 50s and beyond.',
        'sections': [
            ('Hypertrophy programming that progresses', 'Your program is built around proven muscle-building principles: enough hard sets per muscle, smart exercise selection, progressive overload and planned deloads. We track your lifts so every block builds on the last.'),
            ('Bulking, cutting and recomposition', 'Building muscle and losing fat call for different nutrition. Whether you are in a lean bulk, a cut or a recomposition phase, you get calorie and macro targets that are adjusted as your body changes.'),
            ('Contest prep from someone who has done it', 'I have competed in bodybuilding myself. If you are preparing for a show, we plan your prep, posing practice, peak week and the reverse diet afterward, so you bring your best package and recover well.'),
            ('Training smart as a masters lifter', 'Lifting after 35 means paying attention to joints, recovery and exercise selection. Your program builds muscle without beating up your body, so you can keep training for decades.'),
        ],
        'who_for': ['Lifters who want to build visible muscle and size', 'First-time competitors and masters-division athletes', 'Experienced gym-goers who have hit a plateau', 'Anyone who wants an aesthetic physique at any age'],
        'faqs': [
            ('Can I really build muscle after 40?', 'Yes. Research consistently shows that adults of all ages build muscle with progressive resistance training and enough protein. Progress may be a little slower, so consistency and recovery matter more.'),
            ('Do I have to compete?', 'Not at all. Most of my bodybuilding clients just want to build a better physique. Contest prep is available if and when you want it.'),
            ('How long is a typical contest prep?', 'Most preps run 16 to 24 weeks depending on your starting point. We map out the timeline together once you choose a show.'),
        ],
        'plan': 'monthly-coaching',
    },
]

GOALS_BY_SLUG = {g['slug']: g for g in GOALS}

# General FAQs shown on the home page (also emitted as FAQPage structured data)
FAQS = [
    ('Who is Toro Fitness coaching for?', 'Adults in their 30s to 60s who want to lose weight, prepare for a wedding or other big event, or build muscle and pursue bodybuilding. Beginners and experienced lifters are both welcome.'),
    ('Is coaching online or in person?', 'Coaching is online, so you can train at your own gym or at home on your own schedule. You receive your program and nutrition plan digitally and check in with me regularly.'),
    ('I have never lifted weights. Is that a problem?', 'Not at all. Your program starts at your level, and the exercise library has demo videos for the movements you will be doing. We build skill and confidence first.'),
    ('Do I need to follow a strict diet?', 'No. You will get calorie and protein targets, meal ideas and flexible guidelines built around foods you enjoy. Sustainable nutrition beats strict dieting every time.'),
    ('How do I get started?', 'Choose a plan, fill out the short inquiry form with your goal, and I will get back to you within 24 hours to talk about next steps.'),
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
    return render_template('home.html', plans=PLANS, goals=GOALS, faqs=FAQS)

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

def site_root():
    return SITE_URL or request.url_root.rstrip('/')


@app.context_processor
def inject_globals():
    root = site_root()
    return {
        'current_year': date.today().year,
        'site_root': root,
        'canonical_url': root + request.path,
        'nav_goals': GOALS,
    }


@app.route('/<goal_slug>')
def goal_page(goal_slug):
    goal = GOALS_BY_SLUG.get(goal_slug)
    if not goal:
        abort(404)
    others = [g for g in GOALS if g['slug'] != goal_slug]
    return render_template('goal.html', goal=goal, plan=PLANS[goal['plan']], others=others)


# ---------------------------------------------------------------------------
# Client portal (React app in portal/, built into portal/dist by scripts/build-portal.sh)
PORTAL_DIR = os.path.join(app.root_path, 'portal', 'dist')


@app.route('/portal')
def portal_root():
    return redirect('/portal/', code=301)


@app.route('/portal/')
@app.route('/portal/<path:path>')
def portal(path=''):
    file_path = os.path.join(PORTAL_DIR, path)
    if path and os.path.isfile(file_path):
        # Built assets have content hashes in their names, so they can be cached for a long time
        return send_from_directory(PORTAL_DIR, path, max_age=60 * 60 * 24 * 365 if path.startswith('assets/') else 3600)
    if not os.path.isfile(os.path.join(PORTAL_DIR, 'index.html')):
        abort(404)
    # Every other /portal/... address is a page inside the app
    return send_from_directory(PORTAL_DIR, 'index.html', max_age=0)


@app.route('/robots.txt')
def robots():
    body = f"User-agent: *\nAllow: /\nDisallow: /submit-inquiry\nDisallow: /thank-you\nDisallow: /portal/\n\nSitemap: {site_root()}/sitemap.xml\n"
    return Response(body, mimetype='text/plain')


@app.route('/sitemap.xml')
def sitemap():
    pages = [url_for('home'), url_for('about'), url_for('cheat_sheet')]
    pages += [url_for('goal_page', goal_slug=g['slug']) for g in GOALS]
    pages += [url_for('plan', plan_slug=slug) for slug in PLANS]
    today = date.today().isoformat()
    root = site_root()
    urls = ''.join(f'<url><loc>{root}{p}</loc><lastmod>{today}</lastmod></url>' for p in pages)
    xml = f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>'
    return Response(xml, mimetype='application/xml')


@app.errorhandler(404)
def not_found(e):
    return render_template('404.html'), 404


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
def cheat_sheet_old():
    return redirect(url_for('cheat_sheet', **request.args), code=301)


@app.route('/exercise-library')
def cheat_sheet():
    query = request.args.get('q', '')
    exercises = load_exercises()
    results = smart_search(exercises, query)
    return render_template('cheat_sheet.html', exercises=results, q=query)

if __name__ == '__main__':
    app.run(host='0.0.0.0')
