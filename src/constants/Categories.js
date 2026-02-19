// src/constants/Categories.js
// RULE: All `name` values use underscore_keys for i18n translation compatibility.
// This file is the SINGLE SOURCE OF TRUTH for category keys.
// Frontend Categories.ts must always mirror this file exactly.
// NEVER store display strings in the database — always store the raw underscore key.

// === SELLER CATEGORIES (PRODUCTS) ===
const SELLERS_CATEGORIES = [
  // ── ELECTRONICS ──────────────────────────────────────────────────────────
  {
    name: "Phones_Tablets",
    icon: "smartphone",
    subcategories: [
      "Smartphones",
      "Feature_Phones",
      "Tablets",
      "Phone_Accessories",
      "Power_Banks",
      "Earphones",
      "Smart_Watches",
    ],
  },
  {
    name: "Laptops_Computers",
    icon: "monitor",
    subcategories: [
      "Laptops",
      "Desktops",
      "Gaming_PCs",
      "Monitors",
      "Printers",
      "Computer_Accessories",
      "Storage_Devices",
      "Software",
    ],
  },
  {
    name: "TV_Audio_Gaming",
    icon: "tv",
    subcategories: [
      "Televisions",
      "Home_Theater",
      "Soundbars",
      "Speakers",
      "Gaming_Consoles",
      "Video_Games",
      "Projectors",
    ],
  },
  {
    name: "Cameras_Optics",
    icon: "camera",
    subcategories: [
      "Digital_Cameras",
      "Drones",
      "Lenses",
      "Security_Cameras_CCTV",
      "Binoculars",
      "Photography_Accessories",
    ],
  },

  // ── FASHION & BEAUTY ─────────────────────────────────────────────────────
  {
    name: "Womens_Fashion",
    icon: "user",
    subcategories: [
      "Dresses",
      "Tops",
      "Skirts",
      "Trousers_Jeans",
      "Native_Ankara",
      "Lingerie",
      "Shoes",
      "Bags",
      "Jewelry",
    ],
  },
  {
    name: "Mens_Fashion",
    icon: "user",
    subcategories: [
      "Shirts",
      "Trousers",
      "Native_Wear",
      "Suits_Blazers",
      "Underwear",
      "Shoes",
      "Caps",
      "Watches",
      "Belts_Wallets",
    ],
  },
  {
    name: "Babies_Kids",
    icon: "smile",
    subcategories: [
      "Baby_Clothing",
      "Kids_Fashion",
      "Toys",
      "Prams_Strollers",
      "Diapers",
      "Baby_Food",
    ],
  },
  {
    name: "Beauty_Personal_Care",
    icon: "heart",
    subcategories: [
      "Skincare",
      "Hair_Care",
      "Wigs_Extensions",
      "Makeup",
      "Perfumes",
      "Oral_Care",
      "Mens_Grooming",
      "Bath_Body",
    ],
  },

  // ── AUTOMOTIVE ───────────────────────────────────────────────────────────
  {
    name: "Vehicles_Cars",
    icon: "truck",
    subcategories: [
      "Sedans",
      "SUVs_Crossovers",
      "Luxury_Cars",
      "Sports_Cars",
      "Coupes",
      "Hatchbacks",
      "Convertibles",
      "Electric_Hybrid_Cars",
      "Classic_Vintage_Cars",
    ],
  },
  {
    name: "Commercial_Heavy_Duty",
    icon: "hard-drive",
    subcategories: [
      "Pickup_Trucks",
      "Vans_Buses",
      "Trailers",
      "Tractors_Farm_Machinery",
      "Construction_Equipment",
      "Trucks_Lorries",
    ],
  },
  {
    name: "Motorcycles_Powersports",
    icon: "zap",
    subcategories: [
      "Motorbikes",
      "Scooters",
      "Bicycles",
      "ATVs_Quad_Bikes",
      "Tricycles_Keke",
      "Boats_Jet_Skis",
    ],
  },
  {
    name: "Auto_Parts_Care",
    icon: "settings",
    subcategories: [
      "Engine_Parts",
      "Tyres_Rims",
      "Batteries",
      "Brake_Systems",
      "Lighting_Bulbs",
      "Car_Audio_GPS",
      "Oils_Fluids",
      "Exterior_Accessories",
      "Interior_Accessories",
    ],
  },

  // ── HOME & LIVING ────────────────────────────────────────────────────────
  {
    name: "Home_Appliances",
    icon: "home",
    subcategories: [
      "Refrigerators",
      "Washing_Machines",
      "Air_Conditioners",
      "Fans",
      "Microwaves",
      "Generators",
      "Inverters",
      "Solar_Panels",
      "Vacuum_Cleaners",
    ],
  },
  {
    name: "Furniture",
    icon: "layers",
    subcategories: [
      "Sofas_Chairs",
      "Beds_Mattresses",
      "Wardrobes",
      "Dining_Sets",
      "Office_Furniture",
      "Outdoor_Furniture",
      "TV_Stands",
    ],
  },
  {
    name: "Home_Decor",
    icon: "sun",
    subcategories: [
      "Curtains_Blinds",
      "Rugs_Carpets",
      "Wall_Art",
      "Lighting",
      "Beddings",
      "Mirrors",
      "Artificial_Flowers",
    ],
  },
  {
    name: "Kitchen_Dining",
    icon: "coffee",
    subcategories: [
      "Cookware",
      "Kitchen_Appliances",
      "Cutlery",
      "Dinnerware",
      "Storage_Organization",
      "Water_Dispensers",
    ],
  },

  // ── FOOD & GROCERIES ─────────────────────────────────────────────────────
  {
    name: "Fruits_Vegetables",
    icon: "target",
    subcategories: [
      "Fresh_Fruits",
      "Fresh_Vegetables",
      "Herbs_Seasonings",
      "Organic_Produce",
      "Dried_Fruits",
    ],
  },
  {
    name: "Meat_Fish_Poultry",
    icon: "heart",
    subcategories: [
      "Chicken",
      "Beef",
      "Goat_Meat",
      "Pork",
      "Fresh_Fish",
      "Seafood",
      "Frozen_Foods",
      "Snail_Game_Meat",
    ],
  },
  {
    name: "Rice_Beans_Grains",
    icon: "hash",
    subcategories: [
      "Local_Rice",
      "Foreign_Rice",
      "Beans",
      "Garri",
      "Semolina",
      "Flour",
      "Yam_Tubers",
    ],
  },
  {
    name: "Beverages",
    icon: "coffee",
    subcategories: [
      "Soft_Drinks",
      "Juices",
      "Bottled_Water",
      "Tea_Coffee",
      "Energy_Drinks",
      "Wine_Spirits",
      "Beer",
      "Milk_Creams",
    ],
  },

  // ── SPECIALIZED ──────────────────────────────────────────────────────────
  {
    name: "Real_Estate",
    icon: "map",
    subcategories: [
      "For_Rent",
      "For_Sale",
      "Lands_Plots",
      "Short_Let",
      "Office_Space",
      "Shops_Warehouses",
    ],
  },
  {
    name: "Industrial_Business",
    icon: "briefcase",
    subcategories: [
      "Medical_Equipment",
      "Printing_Packaging",
      "Restaurant_Supplies",
      "Retail_Shop_Fittings",
      "Safety_Equipment",
    ],
  },
  {
    name: "Sports_Hobbies",
    icon: "award",
    subcategories: [
      "Gym_Fitness",
      "Outdoor_Sports",
      "Musical_Instruments",
      "Camping_Gear",
      "Board_Games",
    ],
  },
  {
    name: "Other",
    icon: "package",
    subcategories: [
      "Books",
      "Stationery",
      "Pet_Supplies",
      "Gift_Items",
      "Art_Crafts",
    ],
  },
];

// === SERVICE PROVIDER CATEGORIES (SERVICES) ===
const SERVICE_PROVIDER_CATEGORIES = [
  {
    name: "Home_Repair_Maintenance",
    icon: "tool",
    subcategories: [
      "Plumbing",
      "Electrical_Works",
      "AC_Repair",
      "Carpentry",
      "Painting",
      "Tiling",
      "Roofing",
      "Generator_Repair",
      "Solar_Setup",
      "Pest_Control",
    ],
  },
  {
    name: "Cleaning_Services",
    icon: "wind",
    subcategories: [
      "House_Cleaning",
      "Office_Cleaning",
      "Fumigation",
      "Sofa_Carpet_Cleaning",
      "Laundry_Dry_Cleaning",
      "Pool_Cleaning",
    ],
  },
  {
    name: "Logistics_Transport",
    icon: "package",
    subcategories: [
      "Bike_Delivery",
      "Moving_Relocation",
      "Truck_Haulage",
      "Private_Driver",
      "Airport_Pickup",
    ],
  },
  {
    name: "Real_Estate_Services",
    icon: "home",
    subcategories: [
      "Property_Sales_Leasing",
      "Facility_Management",
      "Land_Surveying",
      "Legal_Documentation",
      "Property_Valuation",
      "Short_Let_Apartments",
    ],
  },
  {
    name: "Tech_Gadgets_Repair",
    icon: "cpu",
    subcategories: [
      "Phone_Repair",
      "Laptop_Repair",
      "TV_Repair",
      "Printer_Repair",
      "DSTV_GOTV_Installation",
    ],
  },
  {
    name: "Automotive_Services",
    icon: "truck",
    subcategories: [
      "Mechanic",
      "Auto_Electrician",
      "Panel_Beating",
      "Car_Wash",
      "Towing_Services",
      "Car_Tracking_Installation",
      "Vehicle_Documentation",
    ],
  },
  {
    name: "Events_Entertainment",
    icon: "music",
    subcategories: [
      "Event_Planner",
      "DJ_MC",
      "Photographer",
      "Videographer",
      "Caterer",
      "Cake_Baker",
      "Makeup_Artist",
      "Security_Bouncers",
      "Live_Band",
      "Ushering_Services",
    ],
  },
  {
    name: "Business_Professional",
    icon: "briefcase",
    subcategories: [
      "Graphic_Design",
      "Web_Development",
      "Digital_Marketing",
      "Legal_Services",
      "Accounting",
      "Real_Estate_Agent",
      "Architecture",
      "Interior_Design",
      "Visa_Travel_Consultant",
    ],
  },
  {
    name: "Education_Lessons",
    icon: "book-open",
    subcategories: [
      "Home_Tutors",
      "Music_Lessons",
      "Driving_School",
      "Coding_Tech",
      "Language_Lessons",
      "Skill_Acquisition",
      "JAMB_WAEC_Lessons",
    ],
  },
  {
    name: "Health_Wellness",
    icon: "activity",
    subcategories: [
      "Fitness_Trainer",
      "Massage_Therapist",
      "Home_Nurse",
      "Yoga_Instructor",
      "Nutritionist",
      "Physiotherapist",
    ],
  },
  {
    name: "Personal_Services",
    icon: "scissors",
    subcategories: [
      "Tailoring",
      "Barbering",
      "Hair_Styling",
      "Manicure_Pedicure",
      "Tattoo_Piercing",
      "Nail_Technician",
      "Lashes_Brows",
    ],
  },
  {
    name: "Construction_Fabrication",
    icon: "box",
    subcategories: [
      "Welding_Iron_Work",
      "Bricklaying",
      "Aluminum_Work",
      "POP_Ceiling",
      "Glass_Work",
      "Gate_Fence_Fabrication",
    ],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const getSellerSubcategories = (categoryName) => {
  const cat = SELLERS_CATEGORIES.find((c) => c.name === categoryName);
  return cat ? [...cat.subcategories] : [];
};

const getServiceSubcategories = (categoryName) => {
  const cat = SERVICE_PROVIDER_CATEGORIES.find((c) => c.name === categoryName);
  return cat ? [...cat.subcategories] : [];
};

module.exports = {
  SELLERS_CATEGORIES,
  SERVICE_PROVIDER_CATEGORIES,
  getSellerSubcategories,
  getServiceSubcategories,
};