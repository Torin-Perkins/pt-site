from flask import Flask, render_template, request, redirect, url_for, flash
from flask_mail import Mail, Message
import os
from dotenv import load_dotenv

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

# Plan data
PLANS = {
    'one-time-nutrition': {
        'title': 'One-Time Nutrition Plan',
        'slug': 'one-time-nutrition',
        'description': 'A comprehensive, personalized nutrition plan designed specifically for your goals and lifestyle.',
        'features': [
            'Complete macronutrient breakdown',
            'Customized meal plans',
            'Shopping lists included',
            'Supplement recommendations',
            'Lifetime access to your plan'
        ],
        'price': '$40'
    },
    'monthly-nutrition': {
        'title': 'Monthly Nutrition Plan',
        'slug': 'monthly-nutrition',
        'description': 'Ongoing nutrition support with monthly plan updates and adjustments based on your progress.',
        'features': [
            'Monthly plan revisions',
            'Progress tracking',
            'Email support',
            'Recipe ideas and meal prep tips',
            'Adjustments based on results'
        ],
        'price': '$40 + $20/month'
    },
    'monthly-coaching': {
        'title': 'Monthly Online Coaching',
        'slug': 'monthly-coaching',
        'description': 'Complete training and nutrition coaching package for maximum results and accountability.',
        'features': [
            'Personalized training programs',
            'Monthly nutrition plans',
            'Weekly check-ins',
            'Form review videos',
            'Direct messaging support',
            'Progress tracking and adjustments'
        ],
        'price': '$150/month'
    }
}

@app.route('/')
def home():
    return render_template('home.html', plans=PLANS)

@app.route('/about')
def about():
    return render_template('about.html')

@app.route('/plan/<plan_slug>')
def plan(plan_slug):
    if plan_slug not in PLANS:
        return redirect(url_for('home'))
    return render_template('plan.html', plan=PLANS[plan_slug])

@app.route('/submit-inquiry', methods=['POST'])
def submit_inquiry():
    try:
        name = request.form.get('name')
        email = request.form.get('email')
        phone = request.form.get('phone')
        plan_title = request.form.get('plan_title')
        message = request.form.get('message', '')
        
        # Create email message
        email_body = f"""
New inquiry received:

Name: {name}
Email: {email}
Phone: {phone}
Plan: {plan_title}

Message:
{message}

---
Sent from your Personal Training Website
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

@app.route('/thank-you')
def thank_you():
    return render_template('thank_you.html')

if __name__ == '__main__':
    app.run(host='0.0.0.0')
