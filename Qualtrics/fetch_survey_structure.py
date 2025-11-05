"""
Qualtrics API Proof of Concept - Fetch Survey Structure

This script demonstrates how to fetch the survey structure from Qualtrics
and list all questions currently on the survey.
"""

import requests
import json
from typing import Dict, Any, Optional

# API Configuration
BASE_URL = "https://oregon.yul1.qualtrics.com/API/v3"
SURVEY_ID = "SV_3EOvx4jDUEVIACy"
API_TOKEN = "FcoNLQoHtQVRAoUdIfqexMjIQgC3qqgut9Yg89Xo"

# Headers for API requests
HEADERS = {
    "X-API-TOKEN": API_TOKEN,
    "Content-Type": "application/json"
}


def get_survey_structure() -> Optional[Dict[str, Any]]:
    """
    Fetch the complete survey structure from Qualtrics API.
    
    Returns:
        Dictionary containing survey structure with questions, or None if error
    """
    url = f"{BASE_URL}/surveys/{SURVEY_ID}"
    
    try:
        print(f"Fetching survey structure from: {url}")
        response = requests.get(url, headers=HEADERS)
        response.raise_for_status()  # Raises an HTTPError for bad responses
        
        data = response.json()
        return data
        
    except requests.exceptions.RequestException as e:
        print(f"Error fetching survey structure: {e}")
        if hasattr(e.response, 'text'):
            print(f"Response: {e.response.text}")
        return None


def list_questions(survey_data: Dict[str, Any]) -> None:
    """
    Extract and display all questions from the survey structure.
    
    Args:
        survey_data: The survey structure dictionary from Qualtrics API
    """
    if not survey_data:
        print("No survey data to process.")
        return
    
    # The survey structure typically has questions in different locations
    # depending on the API response format
    
    print("\n" + "="*80)
    print("SURVEY STRUCTURE")
    print("="*80)
    
    # Print basic survey info
    if 'result' in survey_data:
        result = survey_data['result']
        print(f"\nSurvey Name: {result.get('name', 'N/A')}")
        print(f"Survey ID: {result.get('id', 'N/A')}")
        print(f"Status: {result.get('isActive', 'N/A')}")
        
        # Try to find questions in various possible locations
        questions = result.get('questions', {})
        if questions:
            print(f"\nFound {len(questions)} question(s):\n")
            print("-"*80)
            
            for qid, question_data in questions.items():
                print(f"\nQuestion ID: {qid}")
                
                # Extract question text
                question_text = question_data.get('questionText', 'N/A')
                # Remove HTML tags for cleaner display
                import re
                question_text = re.sub(r'<[^>]+>', '', question_text)
                print(f"Question Text: {question_text}")
                
                # Question type
                question_type = question_data.get('questionType', {}).get('type', 'N/A')
                print(f"Question Type: {question_type}")
                
                # Choices (for multiple choice, scale questions, etc.)
                choices = question_data.get('choices', {})
                if choices:
                    print(f"Choices: {len(choices)} option(s)")
                    for choice_id, choice_data in choices.items():
                        choice_text = choice_data.get('text', 'N/A')
                        print(f"  - {choice_id}: {choice_text}")
                
                print("-"*80)
        else:
            print("\nNo questions found in 'questions' field.")
            print("\nFull response structure:")
            print(json.dumps(result, indent=2))
    else:
        print("\nUnexpected response format. Full response:")
        print(json.dumps(survey_data, indent=2))


def main():
    """Main function to fetch and display survey structure."""
    print("Qualtrics API - Survey Structure Fetcher")
    print("="*80)
    
    # Fetch survey structure
    survey_data = get_survey_structure()
    
    if survey_data:
        # Display the questions
        list_questions(survey_data)
        
        # Also save to file for reference
        output_file = "survey_structure.json"
        with open(output_file, 'w') as f:
            json.dump(survey_data, f, indent=2)
        print(f"\n\nFull survey structure saved to: {output_file}")
    else:
        print("\nFailed to fetch survey structure. Please check:")
        print("1. API token is correct")
        print("2. Survey ID is correct")
        print("3. Network connection is working")
        print("4. Survey exists and is accessible")


if __name__ == "__main__":
    main()

