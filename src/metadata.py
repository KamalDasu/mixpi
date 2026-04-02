"""
Metadata management for MixPi recorder
Handles session metadata and marker management
"""

from typing import Dict, List, Optional
from datetime import datetime
import logging


class MetadataManager:
    """
    Manages session metadata and markers
    """
    
    def __init__(self):
        """Initialize metadata manager"""
        self.logger = logging.getLogger('mixpi.metadata')
        self.current_metadata: Dict = {}
        self.metadata_template: Dict = {}
    
    def create_metadata(
        self,
        venue: str = "",
        artist: str = "",
        engineer: str = "",
        notes: str = "",
        **kwargs
    ) -> Dict:
        """
        Create session metadata
        
        Args:
            venue: Venue name
            artist: Artist/band name
            engineer: Engineer name
            notes: Additional notes
            **kwargs: Additional metadata fields
            
        Returns:
            Metadata dictionary
        """
        metadata = {
            'timestamp': datetime.now().isoformat(),
            'venue': venue,
            'artist': artist,
            'engineer': engineer,
            'notes': notes
        }
        
        # Add any additional fields
        metadata.update(kwargs)
        
        self.current_metadata = metadata
        return metadata
    
    def update_metadata(self, **kwargs) -> Dict:
        """
        Update current metadata
        
        Args:
            **kwargs: Fields to update
            
        Returns:
            Updated metadata dictionary
        """
        self.current_metadata.update(kwargs)
        return self.current_metadata
    
    def get_metadata(self) -> Dict:
        """
        Get current metadata
        
        Returns:
            Current metadata dictionary
        """
        return self.current_metadata.copy()
    
    def set_template(self, template: Dict) -> None:
        """
        Set metadata template for recurring sessions
        
        Args:
            template: Template dictionary
        """
        self.metadata_template = template.copy()
        self.logger.info("Metadata template updated")
    
    def apply_template(self) -> Dict:
        """
        Apply metadata template to current metadata
        
        Returns:
            Metadata with template applied
        """
        self.current_metadata = self.metadata_template.copy()
        self.current_metadata['timestamp'] = datetime.now().isoformat()
        return self.current_metadata
    
    def clear_metadata(self) -> None:
        """Clear current metadata"""
        self.current_metadata = {}
