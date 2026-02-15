// types/location.ts



// Nigerian States → Cities → Areas
const NIGERIAN_LOCATIONS={
  "Abia": {
    "Umuahia": ["Isi Gate", "Amuzukwu", "Afara", "Ohiya", "World Bank", "Ubaka", "Okpara Square", "Tower Area", "Umuahia Main"],
    "Aba": ["Ariaria", "Osusu", "Ogbor Hill", "Eziukwu", "Asa", "Port Harcourt Road", "Faulks Road", "Ngwa Road", "Aba-Owerri Road", "Asa Road", "Ehere", "Umuocham", "Ohanku"],
    "Arochukwu": ["Amasu", "Amangwu", "Isu", "Ututu", "Amuvi", "Obinkita", "Ibom"],
    "Ohafia": ["Ebem", "Okon", "Amaekpu", "Asaga", "Isiama", "Elu Ohafia", "Amaekpu Ohafia"],
    "Bende": ["Igbere", "Uzuakoli", "Item", "Ezeukwu", "Ozuitem", "Alayi", "Nkpa"]
  },

  "Adamawa": {
    "Yola": ["Jimeta", "Doubeli", "Makama", "Nasarawo", "Bole", "Wuro Hausa", "Demsawo", "Bekaji", "Karewa", "Alhaji Liman"],
    "Mubi": ["Lokuwa", "Digil", "Sabon Gari", "Burha", "Lamorde", "Kolere", "Gela", "Mubi Town"],
    "Numan": ["Nasarawo", "Sabon Pegi", "Bare", "Gweda", "Dowaya"],
    "Ganye": ["Sugu", "Gamu", "Yebbi", "Toungo"],
    "Jimeta": ["Jambutu", "Police Roundabout", "Damilu", "Doubeli"]
  },

  "Akwa Ibom": {
    "Uyo": ["Itam", "Ewet Housing", "Shelter Afrique", "Ikot Ekpene Road", "Oron Road", "Iboko", "Use Offot", "Udo Udoma", "Nsukara Offot", "Akpan Andem Market", "Abak Road", "Ikpa Road"],
    "Eket": ["Abuja Road", "Ikot Ekpene", "Idua", "Afaha", "Okon", "Esit Eket", "Marina Road"],
    "Ikot Ekpene": ["Nsasak", "Ikot Inyang", "Itam", "Ikot Osurua", "Abak Road", "Uyo Road"],
    "Oron": ["Eyo Abasi", "Iquita", "Oron Beach", "Udung Uko", "Mbo"],
    "Abak": ["Midim", "Atai", "Abak Road"]
  },

  "Anambra": {
    "Awka": ["Aroma", "Amawbia", "Okpuno", "Nibo", "Nnamdi Azikiwe Road", "Zik Avenue", "Temp Site", "UNIZIK", "Ifite", "Agu Awka"],
    "Onitsha": ["Woliwo", "Fegge", "Odoakpu", "Omoba", "Awada", "Main Market", "Bridge Head", "Upper Iweka", "Vienna", "Ochanja", "Iba Pope", "3-3", "Harbour Industrial"],
    "Nnewi": ["Otolo", "Uruagu", "Umudim", "Nnewi North", "Nnewi South", "Nkwo Nnewi", "Okpuno", "Edoji"],
    "Ekwulobia": ["Ula", "Okpo", "Agba", "Amesi", "Umuchiana"],
    "Ihiala": ["Mbosi", "Orlu Road", "Uli", "Okija", "Ubulu"],
  },

  "Bauchi": {
    "Bauchi": ["Ibrahim Bako", "Kofar Ran", "Gwallaga"],
    "Azare": ["Idi", "Nasarawa", "Katagum"],
    "Misau": ["Hardawa", "Akuyam"],
    "Jama'are": ["Hadejia Road", "Gumel"],
    "Ningi": ["Burra", "Kafin Madaki"]
  },

  "Bayelsa": {
    "Yenagoa": ["Opolo", "Akenfa", "Okaka", "Ovom", "Kpansia"],
    "Brass": ["Twon", "Okpoama"],
    "Sagbama": ["Osekwenike", "Agbere"],
    "Ogbia": ["Otuoke", "Kolo", "Anyama"],
    "Ekeremor": ["Aleibiri", "Oporoma"]
  },

  "Benue": {
    "Makurdi": ["High Level", "Wurukum", "North Bank", "Modern Market"],
    "Gboko": ["Tom Anyo", "Adekaa"],
    "Otukpo": ["Ogobia", "Upu"],
    "Katsina-Ala": ["Abaji", "Gbajimba"],
    "Vandeikya": ["Mbadede", "Tse Mker"]
  },

  "Borno": {
    "Maiduguri": ["Baga Road", "Giwa Barracks", "Custom", "GRA"],
    "Bama": ["Kasugula", "Shehuri"],
    "Biu": ["Dutsen", "Galtimari"],
    "Dikwa": ["Central", "Fadagui"],
    "Gubio": ["Shuwari", "Gubio Central"]
  },

  "Cross River": {
    "Calabar": ["Mariaba", "Ika Ika Oqua", "Goldie", "Summit Hills"],
    "Ikom": ["Four Corners", "Nkarasi"],
    "Ogoja": ["Ishibori", "Igoli"],
    "Obudu": ["Utugwang", "Beggi"],
    "Ugep": ["Ikpakapit", "Ibom"]
  },

  "Delta": {
    "Asaba": ["Okpanam Road", "GRA", "Ibusa Road", "Summit Junction", "Anwai Road", "Jesus Saves", "Directorate Road"],
    "Warri": ["Ekpan", "Jakpa", "Airport Road", "Enerhen", "Effurun", "PTI Road", "Refinery Road", "NPA", "Ogunu"],
    "Sapele": ["Amukpe", "Okirighwre"],
    "Ughelli": ["Otovwodo", "Eruemukohwarien"],
    "Agbor": ["Owa", "Ika South"]
  },

  "Ebonyi": {
    "Abakaliki": ["Presco", "Onuebonyi", "Spera-In-Deo"],
    "Afikpo": ["Ndibe", "Ezera"],
    "Onueke": ["Ezza North", "Ezza South"],
    "Ezza": ["Umuezeoka", "Ezzagu"],
    "Ishielu": ["Ezillo", "Ntezi"]
  },

  "Edo": {
    "Benin City": ["GRA", "Ugbowo", "Sapele Road", "Uselu", "Ikpoba Hill", "New Benin", "Ring Road", "Ekenwan", "Siluko", "Upper Sakponba", "Adesuwa", "Boundary Road", "Airport Road"],
    "Auchi": ["Jattu", "Ughiole"],
    "Ekpoma": ["Uke", "Iruekpen"],
    "Uromi": ["Evia", "Amedokhian"],
    "Igarra": ["Akoko Road", "Etuno"],
    
  },

  "Ekiti": {
    "Ado-Ekiti": ["Oke-Ila", "Oke-Iyinmi", "Fajuyi", "Igbole"],
    "Ikere": ["Odo", "Uro"],
    "Efon-Alaaye": ["Efon Central"],
    "Ijero": ["Ikoro", "Epe"],
    "Ikole": ["Egbe", "Ara"]
  },

  "Enugu": {
    "Enugu": [
    "Independence Layout", "New Haven", "Uwani", "GRA", "Achara Layout", "Abakpa", "Emene", "Ogui", "Asata", "Coal Camp", "Ogbete", "Trans Ekulu", "Thinkers Corner", "Presco", "Gariki", "Artisan", "Zik Avenue", "Okpara Avenue", "Presidential Road"],
    "Nsukka": ["Orba", "Opi", "University Road", "Onuiyi", "Ibagwa", "Obukpa"],
    "Oji River": ["Achi", "Inyi"],
    "Agbani": ["Ugwuaji", "Obe"],
    "Udi": ["Amokwe", "Eke"]
  },

  "FCT": {
    "Abuja": ["Maitama", "Asokoro", "Wuse", "Wuse 2", "Garki", "Garki 2", "Central Area", "Utako", "Jabi", "Guzape", "Katampe", "Life Camp", "Kado", "Durumi", "Gudu", "Apo", "Lokogoma", "Galadimawa", "Dawaki", "Kubwa", "Dutse", "Bwari", "Gwagwalada", "Lugbe", "Karu", "Nyanya", "Mararaba", "Jikwoyi", "Kurudu", "Kuje", "Kwali", "Abaji", "Gwarinpa", "Karmo", "Idu", "Dakibiyu", "Dei-Dei", "Zuba", "Suleja", "Madalla"],
    "Gwagwalada": ["Kutunku", "Angwan Dodo"],
    "Kuje": ["Chibiri", "Gaube"],
    "Bwari": ["Kawu", "Kogo"],
    "Kwali": ["Yangoji", "Kilankwa"]
  },

  "Gombe": {
    "Gombe": ["Nasarawo", "Pantami", "Federal Low Cost"],
    "Kumo": ["Liji", "Kalshingi"],
    "Deba": ["Kunji", "Lano"],
    "Billiri": ["Bare", "Tudu"],
    "Kaltungo": ["Awachie", "Boji"]
  },

  "Imo": {
    "Owerri": ["Ikenegbu", "World Bank", "Orji", "Amakohia", "New Owerri", "Egbu Road", "Douglas Road", "Wetheral", "Okigwe Road", "MCC Road", "Tetlow", "Aladinma"],
    "Orlu": ["Umuowa", "Okporo"],
    "Okigwe": ["Ubah", "Anara"],
    "Mbaise": ["Ahiara", "Eke Nguru"],
    "Nkwerre": ["Amaigbo", "Umudi"]
  },

  "Jigawa": {
    "Dutse": ["Sabon Gari", "Danfodio"],
    "Hadejia": ["Kofar Arewa", "Yamma"],
    "Gumel": ["Central", "Garin Alhaji"],
    "Kazaure": ["Badawa", "Kofar Kudu"],
    "Ringim": ["Chai-Chai", "Sankara"]
  },

  "Kaduna": {
    "Kaduna": [
      "Barnawa", "Ungwan Rimi", "Kaduna South", "Kakuri", "Sabon Tasha", "Television", "Malali", "Ungwan Dosa", "Narayi", "Gonigora", "Kawo", "Mando", "Rigasa", "Tudun Wada", "Badiko", "Kudenda"
    ],
    "Zaria": ["Sabon Gari", "Samuru", "Tudun Wada Zaria", "PZ", "Angwan Liman"],
    "Kafanchan": ["Kagoro", "Fadan Kaje"],
    "Kagoro": ["Gidan Waya", "Kaura"],
    "Kachia": ["Sabon Sarki", "Awon"]
  },

  "Kano": {
    "Kano": [ "Fagge", "Tarauni", "Gwale", "Nassarawa", "Dala", "Kumbotso", "Ungogo", "Kano Municipal", "Sabon Gari", "Farm Centre", "Hotoro", "Dorayi", "Zango", "Sharada", "Challawa", "Dawakin Tofa", "Gwarzo Road", "Zaria Road", "Hadejia Road", "Bompai", "Nomansland"],
    "Wudil": ["Lajawa", "Dankaza"],
    "Gwarzo": ["Kutama", "Sabon Gari"],
    "Bichi": ["Dawaki", "Bagwai"],
    "Rano": ["Zango", "Lausu"]
  },

  "Katsina": {
    "Katsina": ["Kofar Soro", "Kofar Kaura", "GRA"],
    "Daura": ["Kanti", "Dungu"],
    "Funtua": ["Sabon Gari", "Galadima"],
    "Malumfashi": ["Dagura", "Galadanci"],
    "Kankia": ["Kofar Yandaka", "Kuraye"]
  },

  "Kebbi": {
    "Birnin Kebbi": ["Makera", "GRA", "Kola"],
    "Argungu": ["Tudun Wada", "Lailaba"],
    "Yauri": ["Shanga", "Ungu"],
    "Zuru": ["Isgogo", "Rafin Zuru"],
    "Kalgo": ["Sirdi", "Danko"]
  },

  "Kogi": {
    "Lokoja": ["Ganaja", "Adankolo", "Zone 8"],
    "Okene": ["Iruvucheba", "Otutu"],
    "Kabba": ["Gbeleko", "Zango"],
    "Idah": ["Sabon Gari", "Ukwokolo"],
    "Ankpa": ["Enjema", "Angwa"]
  },

  "Kwara": {
    "Ilorin": ["Geri Alimi", "Tanke", "Challenge", "Sabo Oke"],
    "Offa": ["Ijesha", "Owode"],
    "Jebba": ["Kainji Road", "Moshalashi"],
    "Lafiagi": ["Shonga", "Gwasoro"],
    "Pategi": ["Kpada", "Lade"]
  },

  "Lagos": {
    "Ikeja": ["Alausa", "Opebi", "Allen Avenue", "Maryland", "GRA Ikeja", "Ogba", "Omole", "Magodo", "Ojodu Berger", "Adeniyi Jones", "Awolowo Way", "Kudirat Abiola Way", "Aromire", "Adekunle Fajuyi", "Airport Road"],
    "Lagos Island": ["Obalende", "CMS", "Idumota", "Balogun", "Isale Eko", "Broad Street", "Marina", "Victoria Island", "Ikoyi", "Bourdillon", "Banana Island", "Dolphin Estate", "Oniru", "Osborne", "Parkview"],
    "Lekki": ["Lekki Phase 1", "Lekki Phase 2", "Chevron", "Ikate", "Elegushi", "VGC", "Ikota", "Ajah", "Sangotedo", "Awoyaya", "Epe Expressway", "Abraham Adesanya", "Ogombo", "Victory Island"],
    "Ikorodu": ["Igbogbo", "Ebute", "Imota", "Ijede", "Odonguyan", "Maya", "Ibeshe", "Igbopa", "Ikorodu Garage"],
    "Surulere": ["Aguda", "Ijesha", "Bode Thomas", "Lawanson", "Adelabu", "Masha", "Ogunlana Drive", "Western Avenue"],
    "Yaba": ["Sabo", "Tejuosho", "Alagomeji", "Adekunle", "Akoka", "Onike", "Fadeyi", "Jibowu", "Ebute Metta"],
    "Festac": ["Festac Town", "Amuwo Odofin", "Satellite Town", "Ago Palace Way", "Okota", "Isolo", "Oshodi", "Mafoluku"],
    "Epe": ["Ita Opo", "Popo Oba"],
    "Badagry": ["Ajara", "Ibereko"]
  },

  "Nasarawa": {
    "Lafia": ["Kwandere", "Agyaragu"],
    "Keffi": ["Angwan Lambu", "Angwan Tiv"],
    "Akwanga": ["Nunkai", "Andaha"],
    "Nasarawa": ["Loko", "Udeni"],
    "Doma": ["Alagye", "Rutu"]
  },

  "Niger": {
    "Minna": ["Chanchaga", "Tunga", "Bosso", ],
    "Bida": ["Bariki", "Masaba"],
    "Kontagora": ["Maikujeri", "Tunga", "Usubu", "GRA", "GRA Phase 2", "Federal Low Cost"],
    "Suleja": ["Madalla", "Maje"],
    "Lapai": ["Evuti", "Gulu"]
  },

  "Ogun": {
    "Abeokuta": ["Asero", "Adigbe", "Oke-Ilewo"],
    "Ijebu Ode": ["Molipa", "Itantebo"],
    "Sagamu": ["Makun", "Ode Lemo"],
    "Ota": ["Sango", "Owode"],
    "Ilaro": ["Oke Odan", "Sabo"]
  },

  "Ondo": {
    "Akure": ["Alagbaka", "Ijapo", "Oke Aro"],
    "Ondo": ["Yaba", "Enuowa"],
    "Owo": ["Isuada", "Ipele"],
    "Ikare": ["Okoja", "Okorun"],
    "Ore": ["Odunwo", "Mobolorunduro"]
  },

  "Osun": {
    "Osogbo": ["Oke Fia", "Oke Baale", "Testing Ground"],
    "Ile-Ife": ["Lagere", "Oduduwa College"],
    "Ilesa": ["Owa Obokun", "Imo"],
    "Ede": ["Sekona", "Oke Gada"],
    "Iwo": ["Oke-Adan", "Agbowo"]
  },

  "Oyo": {
    "Ibadan": [
      "Bodija", "Challenge", "Jericho", "Dugbe", "Molete", "Ring Road", "Oke Ado", "Agodi", "Gate", "Oje", "Oja Oba", "Mapo", "Beere", "Ojoo", "Sango", "UI", "Agbowo", "Bashorun", "Akobo", "Oluyole", "Elebu", "Akala Express", "New Garage", "Monatan", "Alakia", "Egbeda", "Olorunda", "Apata", "Elewura"
    ],
    "Ogbomoso": ["Takie", "Aroje", "Oke Anu", "Sabokoro", "Oja Igbo"],
    "Oyo": ["Akesan", "Fasola", "Isale Oyo"],
    "Iseyin": ["Oke Ola", "Oja Oba"],
    "Saki": ["Irekere", "Okere"]
  },

  "Plateau": {
    "Jos": ["Rayfield", "Tudun Wada", "Terminus"],
    "Bukuru": ["Kuru", "Gyel"],
    "Pankshin": ["Chip", "Bwall"],
    "Shendam": ["Poeship", "Kalong"],
    "Langtang": ["Gazum", "Kuffen"]
  },

  "Rivers": {
    "Port Harcourt": [
      "GRA Phase 1", "GRA Phase 2", "GRA Phase 3", "Trans Amadi", "D-Line", "Rumuokoro", "Rumuola", "Rumuigbo", "Rumuomasi", "Woji", "Rumuodara", "Eliozu", "Rukpokwu", "Rumuokwuta", "Ada George", "Rumuolumeni", "Eneka", "Rumuokoro", "Rumuagholu", "Ozuoba", "Rumuibekwe", "Elelenwo", "Rumuepirikom", "Rumuokwurusi", "Diobu", "Mile 1", "Mile 2", "Mile 3", "Mile 4", "Borikiri", "Old GRA", "Town"
    ],
    "Obio-Akpor": ["Rumuodumaya", "Rumuokoro", "Rumuigbo", "Elimgbu", "Mgbuoba"],
    "Eleme": ["Alesa", "Aleto", "Onne", "Ogale"],
    "Okrika": ["Ogoloma", "Ibaka"],
    "Bonny": ["Finima", "Iwoama"]
  },

  "Sokoto": {
    "Sokoto": ["Gawon Nama", "Runjin Sambo"],
    "Gwadabawa": ["Gidanje", "Illela Road"],
    "Bodinga": ["Dingyadi", "Sifawa"],
    "Wurno": ["Achida", "Magarya"],
    "Goronyo": ["Takakume", "Shinaka"]
  },

  "Taraba": {
    "Jalingo": ["Sabon Gari", "Mile Six"],
    "Wukari": ["Hospital Road", "Avyi"],
    "Ibi": ["Ibi Central", "Sabon Pegi"],
    "Bali": ["Maihula", "Tikari"],
    "Gembu": ["Kabri", "Gembu Town"]
  },

  "Yobe": {
    "Damaturu": ["Nayinawa", "Maisandari"],
    "Potiskum": ["Mamudo", "NPN"],
    "Gashua": ["Garun Gawa", "Abuja Quarters"],
    "Nguru": ["Bulabulin", "Bajoga"],
    "Geidam": ["Hausari", "Shekau"]
  },

  "Zamfara": {
    "Gusau": ["Sabon Gari", "Tudun Wada"],
    "Kaura Namoda": ["Galadima", "Kura"],
    "Talata Mafara": ["Bata", "Birnin Magaji"],
    "Anka": ["Dan Galadima", "Sabon Gari"],
    "Bungudu": ["Kwatar Kwashi", "Sakkida"]
  }
};

// ======== HELPER FUNCTIONS (CommonJS) ========

const getAllStates = () => {
  return Object.keys(NIGERIAN_LOCATIONS).sort();
};

const getCitiesByState = (state) => {
  return state && NIGERIAN_LOCATIONS[state]
    ? Object.keys(NIGERIAN_LOCATIONS[state]).sort()
    : [];
};

const getAreasByCity = (state, city) => {
  if (!state || !city) return [];
  return NIGERIAN_LOCATIONS[state]?.[city] || [];
};

// Export using CommonJS for Node.js backend
module.exports = {
  NIGERIAN_LOCATIONS,
  getAllStates,
  getCitiesByState,
  getAreasByCity
};