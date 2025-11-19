#!/usr/bin/env python3
"""
User Status Diagnostic Script
Generates an HTML diagnostic page that checks localStorage for user session state
Open the generated HTML file in a browser to see complete user status report
"""

import os
from pathlib import Path
from datetime import datetime

# Get the backend directory
BACKEND_DIR = Path(__file__).parent
OUTPUT_FILE = BACKEND_DIR / "user_status_diagnostic.html"

HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>User Status Diagnostic</title>
    <style>
        body {
            font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
            background: #1a1a1a;
            color: #e0e0e0;
            padding: 20px;
            line-height: 1.6;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        h1 {
            color: #4CAF50;
            border-bottom: 2px solid #4CAF50;
            padding-bottom: 10px;
        }
        h2 {
            color: #2196F3;
            margin-top: 30px;
            border-left: 4px solid #2196F3;
            padding-left: 10px;
        }
        .section {
            background: #2a2a2a;
            padding: 15px;
            margin: 15px 0;
            border-radius: 5px;
            border: 1px solid #444;
        }
        .key {
            color: #FFC107;
            font-weight: bold;
        }
        .value {
            color: #4CAF50;
        }
        .null {
            color: #f44336;
        }
        .success {
            color: #4CAF50;
        }
        .warning {
            color: #FF9800;
        }
        .error {
            color: #f44336;
        }
        pre {
            background: #1a1a1a;
            padding: 10px;
            border-radius: 5px;
            overflow-x: auto;
            border: 1px solid #444;
        }
        .button {
            background: #2196F3;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
            margin: 10px 5px;
        }
        .button:hover {
            background: #1976D2;
        }
        .button.danger {
            background: #f44336;
        }
        .button.danger:hover {
            background: #d32f2f;
        }
        .timestamp {
            color: #888;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔍 User Status Diagnostic Report</h1>
        <p class="timestamp">Generated: {timestamp}</p>
        
        <div class="section">
            <button class="button" onclick="refreshReport()">🔄 Refresh Report</button>
            <button class="button" onclick="copyToClipboard()">📋 Copy Report to Clipboard</button>
            <button class="button danger" onclick="clearAllData()">🗑️ Clear All Study Data (Danger!)</button>
        </div>

        <h2>📋 Participant ID</h2>
        <div class="section" id="participantId"></div>

        <h2>📊 Session State</h2>
        <div class="section" id="sessionState"></div>

        <h2>📝 Session Responses</h2>
        <div class="section" id="sessionResponses"></div>

        <h2>🏁 Workflow Flags</h2>
        <div class="section" id="workflowFlags"></div>

        <h2>🌋 Volcano Selection</h2>
        <div class="section" id="volcanoSelection"></div>

        <h2>🎯 Mode</h2>
        <div class="section" id="mode"></div>

        <h2>📦 All localStorage Keys</h2>
        <div class="section" id="allKeys"></div>

        <h2>🔧 Diagnostic Actions</h2>
        <div class="section">
            <h3>Reset Study Flags</h3>
            <button class="button" onclick="resetStudyFlags()">Reset All Study Flags</button>
            <p>This will reset all study workflow flags (participant setup, welcome, tutorial, etc.)</p>
            
            <h3>Clear Session</h3>
            <button class="button danger" onclick="clearSession()">Clear Current Session</button>
            <p>This will clear the current session state and responses</p>
        </div>
    </div>

    <script>
        function getParticipantId() {
            return localStorage.getItem('participantId') || null;
        }

        function getSessionState() {
            try {
                const stateJson = localStorage.getItem('participant_session_state');
                if (!stateJson) return null;
                return JSON.parse(stateJson);
            } catch (e) {
                return { error: 'Failed to parse: ' + e.message };
            }
        }

        function getSessionResponses(participantId) {
            if (!participantId) return null;
            try {
                const key = `participant_response_${participantId}`;
                const responsesJson = localStorage.getItem(key);
                if (!responsesJson) return null;
                return JSON.parse(responsesJson);
            } catch (e) {
                return { error: 'Failed to parse: ' + e.message };
            }
        }

        function getWorkflowFlags() {
            const flags = {
                'study_has_seen_participant_setup': localStorage.getItem('study_has_seen_participant_setup'),
                'study_has_seen_welcome': localStorage.getItem('study_has_seen_welcome'),
                'study_has_seen_tutorial': localStorage.getItem('study_has_seen_tutorial'),
                'study_last_awesf_date': localStorage.getItem('study_last_awesf_date'),
                'study_weekly_session_count': localStorage.getItem('study_weekly_session_count'),
                'study_week_start_date': localStorage.getItem('study_week_start_date'),
                'study_pre_survey_completion_date': localStorage.getItem('study_pre_survey_completion_date')
            };
            return flags;
        }

        function getAllKeys() {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                keys.push(key);
            }
            return keys.sort();
        }

        function formatValue(value) {
            if (value === null || value === undefined) {
                return '<span class="null">❌ NOT SET</span>';
            }
            if (typeof value === 'object') {
                return '<pre>' + JSON.stringify(value, null, 2) + '</pre>';
            }
            return '<span class="value">' + String(value) + '</span>';
        }

        function generateReport() {
            const participantId = getParticipantId();
            const sessionState = getSessionState();
            const sessionResponses = getSessionResponses(participantId);
            const workflowFlags = getWorkflowFlags();
            const selectedVolcano = localStorage.getItem('selectedVolcano');
            const selectedMode = localStorage.getItem('selectedMode');
            const allKeys = getAllKeys();

            // Participant ID
            document.getElementById('participantId').innerHTML = 
                '<span class="key">Participant ID:</span> ' + formatValue(participantId);

            // Session State
            let sessionStateHtml = '<span class="key">Session State:</span><br>';
            if (sessionState) {
                sessionStateHtml += '<pre>' + JSON.stringify({
                    status: sessionState.status,
                    sessionId: sessionState.sessionId,
                    participantId: sessionState.participantId,
                    startedAt: sessionState.startedAt,
                    submittedAt: sessionState.submittedAt || 'Not submitted',
                    qualtricsResponseId: sessionState.qualtricsResponseId || 'None',
                    lastUpdated: sessionState.lastUpdated
                }, null, 2) + '</pre>';
            } else {
                sessionStateHtml += '<span class="null">❌ NO SESSION STATE FOUND</span>';
            }
            document.getElementById('sessionState').innerHTML = sessionStateHtml;

            // Session Responses
            let responsesHtml = '<span class="key">Session Responses:</span><br>';
            if (sessionResponses) {
                responsesHtml += '<pre>' + JSON.stringify({
                    sessionId: sessionResponses.sessionId,
                    participantId: sessionResponses.participantId,
                    hasPre: !!sessionResponses.pre,
                    hasPost: !!sessionResponses.post,
                    hasAwesf: !!sessionResponses.awesf,
                    hasActivityLevel: !!sessionResponses.activityLevel,
                    submitted: sessionResponses.submitted || false,
                    submittedAt: sessionResponses.submittedAt || 'Not submitted',
                    qualtricsResponseId: sessionResponses.qualtricsResponseId || 'None',
                    createdAt: sessionResponses.createdAt
                }, null, 2) + '</pre>';
            } else {
                responsesHtml += '<span class="null">❌ NO RESPONSES FOUND</span>';
            }
            document.getElementById('sessionResponses').innerHTML = responsesHtml;

            // Workflow Flags
            let flagsHtml = '<span class="key">Workflow Flags:</span><br>';
            Object.entries(workflowFlags).forEach(([key, value]) => {
                flagsHtml += `<div><span class="key">${key}:</span> ${formatValue(value)}</div>`;
            });
            document.getElementById('workflowFlags').innerHTML = flagsHtml;

            // Volcano Selection
            document.getElementById('volcanoSelection').innerHTML = 
                '<span class="key">Selected Volcano:</span> ' + formatValue(selectedVolcano);

            // Mode
            document.getElementById('mode').innerHTML = 
                '<span class="key">Selected Mode:</span> ' + formatValue(selectedMode || 'Using default');

            // All Keys
            let keysHtml = '<span class="key">All localStorage Keys (${allKeys.length} total):</span><br><pre>';
            allKeys.forEach(key => {
                keysHtml += key + '\\n';
            });
            keysHtml += '</pre>';
            document.getElementById('allKeys').innerHTML = keysHtml.replace('${allKeys.length}', allKeys.length);
        }

        function refreshReport() {
            generateReport();
            alert('Report refreshed!');
        }

        function copyToClipboard() {
            const participantId = getParticipantId();
            const sessionState = getSessionState();
            const sessionResponses = getSessionResponses(participantId);
            const workflowFlags = getWorkflowFlags();
            
            const report = `USER STATUS DIAGNOSTIC REPORT
Generated: ${new Date().toISOString()}

PARTICIPANT ID: ${participantId || 'NOT FOUND'}

SESSION STATE:
${JSON.stringify(sessionState, null, 2)}

SESSION RESPONSES:
${JSON.stringify(sessionResponses, null, 2)}

WORKFLOW FLAGS:
${JSON.stringify(workflowFlags, null, 2)}

VOLCANO SELECTION: ${localStorage.getItem('selectedVolcano') || 'NOT SET'}
MODE: ${localStorage.getItem('selectedMode') || 'Using default'}
`;

            navigator.clipboard.writeText(report).then(() => {
                alert('Report copied to clipboard!');
            }).catch(err => {
                alert('Failed to copy: ' + err);
            });
        }

        function resetStudyFlags() {
            if (confirm('Are you sure you want to reset all study flags? This will make the system act like a first-time visit.')) {
                const flags = [
                    'study_has_seen_participant_setup',
                    'study_has_seen_welcome',
                    'study_has_seen_tutorial',
                    'study_last_awesf_date',
                    'study_weekly_session_count',
                    'study_week_start_date',
                    'study_pre_survey_completion_date'
                ];
                flags.forEach(flag => localStorage.removeItem(flag));
                alert('Study flags reset! Refresh the page to see changes.');
                generateReport();
            }
        }

        function clearSession() {
            const participantId = getParticipantId();
            if (!participantId) {
                alert('No participant ID found.');
                return;
            }
            if (confirm('Are you sure you want to clear the current session? This will delete all session data and responses.')) {
                localStorage.removeItem('participant_session_state');
                localStorage.removeItem(`participant_response_${participantId}`);
                alert('Session cleared!');
                generateReport();
            }
        }

        function clearAllData() {
            if (confirm('⚠️ DANGER: Are you absolutely sure you want to clear ALL localStorage data? This cannot be undone!')) {
                if (confirm('This will delete EVERYTHING including participant ID, session data, workflow flags, and all other stored data. Continue?')) {
                    localStorage.clear();
                    alert('All data cleared! Page will reload.');
                    location.reload();
                }
            }
        }

        // Generate report on page load
        generateReport();
    </script>
</body>
</html>
"""

def main():
    """Generate the diagnostic HTML file"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    # Replace timestamp placeholder (using string replacement instead of format to avoid CSS brace issues)
    html_content = HTML_TEMPLATE.replace("{timestamp}", timestamp)
    
    try:
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            f.write(html_content)
        
        print(f"✅ Diagnostic page generated: {OUTPUT_FILE}")
        print(f"📂 Open this file in your browser to view user status")
        print(f"   File path: {OUTPUT_FILE.absolute()}")
        
    except Exception as e:
        print(f"❌ Error generating diagnostic page: {e}")
        return 1
    
    return 0

if __name__ == "__main__":
    exit(main())

