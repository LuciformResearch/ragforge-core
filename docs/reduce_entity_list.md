● Read(services/gliner_service/entity-extraction.yaml)                                   
  ⎿  Read 200 lines                                                                      
                                                                                         
● Voici l'analyse des types actuels :                                                    
  ┌───────────────┬─────────────────┬───────────────────┐                                
  │    Domaine    │ Nb entity_types │ Nb relation_types │                                
  ├───────────────┼─────────────────┼───────────────────┤                                
  │ defaults      │ 12              │ 8                 │                                
  ├───────────────┼─────────────────┼───────────────────┤                                
  │ ecommerce     │ 14              │ 7                 │                                
  ├───────────────┼─────────────────┼───────────────────┤                                
  │ code          │ 16              │ 10                │                                
  ├───────────────┼─────────────────┼───────────────────┤                                
  │ documentation │ 14              │ 8                 │                                
  ├───────────────┼─────────────────┼───────────────────┤                                
  │ legal         │ 11              │ 5                 │                                
  └───────────────┴─────────────────┴───────────────────┘                                
  Suggestions de merge/réduction                                                         
                                                                                         
  Domain code (16 → ~10)                                                                 
                                                                                         
  # Avant (16 types)                                                                     
  - function, class, method, variable, module, library                                   
  - api, endpoint, parameter, return_type                                                
  - error, exception, configuration                                                      
  - file_path, url, git_ref, package_name                                                
                                                                                         
  # Après (10 types) - merges suggérés                                                   
  - code_element      # function, class, method, variable (le parser TS fait déjà ça)    
  - module            # module, library, package_name                                    
  - api_element       # api, endpoint                                                    
  - type_info         # parameter, return_type                                           
  - error             # error, exception                                                 
  - configuration                                                                        
  - reference         # file_path, url, git_ref                                          
                                                                                         
  Domain documentation (14 → ~8)                                                         
                                                                                         
  # Avant                                                                                
  - concept, feature, requirement, specification, user_story, use_case                   
  - actor, system, component, version, release, milestone                                
  - file_path, url, endpoint, section_ref                                                
                                                                                         
  # Après (8 types)                                                                      
  - concept           # concept, specification                                           
  - feature           # feature, requirement, user_story, use_case                       
  - component         # actor, system, component                                         
  - version           # version, release, milestone                                      
  - reference         # file_path, url, endpoint, section_ref                            
                                                                                         
  Domain ecommerce (14 → ~8)                                                             
                                                                                         
  # Garder pertinent pour beauté/commerce                                                
  - product, brand, category                                                             
  - price             # price, currency, amount → un seul                                
  - attribute         # size, color, material, hair_type, skin_type                      
  - ingredient, certification, benefit                                                   
                                                                                         
  Moins de types = plus rapide + moins de bruit.                                         
                                            