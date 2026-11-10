/*
   Licensed to the Apache Software Foundation (ASF) under one or more
   contributor license agreements.  See the NOTICE file distributed with
   this work for additional information regarding copyright ownership.
   The ASF licenses this file to You under the Apache License, Version 2.0
   (the "License"); you may not use this file except in compliance with
   the License.  You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
var showControllersOnly = false;
var seriesFilter = "";
var filtersOnlySampleSeries = true;

/*
 * Add header in statistics table to group metrics by category
 * format
 *
 */
function summaryTableHeader(header) {
    var newRow = header.insertRow(-1);
    newRow.className = "tablesorter-no-sort";
    var cell = document.createElement('th');
    cell.setAttribute("data-sorter", false);
    cell.colSpan = 1;
    cell.innerHTML = "Requests";
    newRow.appendChild(cell);

    cell = document.createElement('th');
    cell.setAttribute("data-sorter", false);
    cell.colSpan = 3;
    cell.innerHTML = "Executions";
    newRow.appendChild(cell);

    cell = document.createElement('th');
    cell.setAttribute("data-sorter", false);
    cell.colSpan = 7;
    cell.innerHTML = "Response Times (ms)";
    newRow.appendChild(cell);

    cell = document.createElement('th');
    cell.setAttribute("data-sorter", false);
    cell.colSpan = 1;
    cell.innerHTML = "Throughput";
    newRow.appendChild(cell);

    cell = document.createElement('th');
    cell.setAttribute("data-sorter", false);
    cell.colSpan = 2;
    cell.innerHTML = "Network (KB/sec)";
    newRow.appendChild(cell);
}

/*
 * Populates the table identified by id parameter with the specified data and
 * format
 *
 */
function createTable(table, info, formatter, defaultSorts, seriesIndex, headerCreator) {
    var tableRef = table[0];

    // Create header and populate it with data.titles array
    var header = tableRef.createTHead();

    // Call callback is available
    if(headerCreator) {
        headerCreator(header);
    }

    var newRow = header.insertRow(-1);
    for (var index = 0; index < info.titles.length; index++) {
        var cell = document.createElement('th');
        cell.innerHTML = info.titles[index];
        newRow.appendChild(cell);
    }

    var tBody;

    // Create overall body if defined
    if(info.overall){
        tBody = document.createElement('tbody');
        tBody.className = "tablesorter-no-sort";
        tableRef.appendChild(tBody);
        var newRow = tBody.insertRow(-1);
        var data = info.overall.data;
        for(var index=0;index < data.length; index++){
            var cell = newRow.insertCell(-1);
            cell.innerHTML = formatter ? formatter(index, data[index]): data[index];
        }
    }

    // Create regular body
    tBody = document.createElement('tbody');
    tableRef.appendChild(tBody);

    var regexp;
    if(seriesFilter) {
        regexp = new RegExp(seriesFilter, 'i');
    }
    // Populate body with data.items array
    for(var index=0; index < info.items.length; index++){
        var item = info.items[index];
        if((!regexp || filtersOnlySampleSeries && !info.supportsControllersDiscrimination || regexp.test(item.data[seriesIndex]))
                &&
                (!showControllersOnly || !info.supportsControllersDiscrimination || item.isController)){
            if(item.data.length > 0) {
                var newRow = tBody.insertRow(-1);
                for(var col=0; col < item.data.length; col++){
                    var cell = newRow.insertCell(-1);
                    cell.innerHTML = formatter ? formatter(col, item.data[col]) : item.data[col];
                }
            }
        }
    }

    // Add support of columns sort
    table.tablesorter({sortList : defaultSorts});
}

$(document).ready(function() {

    // Customize table sorter default options
    $.extend( $.tablesorter.defaults, {
        theme: 'blue',
        cssInfoBlock: "tablesorter-no-sort",
        widthFixed: true,
        widgets: ['zebra']
    });

    var data = {"OkPercent": 100.0, "KoPercent": 0.0};
    var dataset = [
        {
            "label" : "FAIL",
            "data" : data.KoPercent,
            "color" : "#FF6347"
        },
        {
            "label" : "PASS",
            "data" : data.OkPercent,
            "color" : "#9ACD32"
        }];
    $.plot($("#flot-requests-summary"), dataset, {
        series : {
            pie : {
                show : true,
                radius : 1,
                label : {
                    show : true,
                    radius : 3 / 4,
                    formatter : function(label, series) {
                        return '<div style="font-size:8pt;text-align:center;padding:2px;color:white;">'
                            + label
                            + '<br/>'
                            + Math.round10(series.percent, -2)
                            + '%</div>';
                    },
                    background : {
                        opacity : 0.5,
                        color : '#000'
                    }
                }
            }
        },
        legend : {
            show : true
        }
    });

    // Creates APDEX table
    createTable($("#apdexTable"), {"supportsControllersDiscrimination": true, "overall": {"data": [0.4358974358974359, 500, 1500, "Total"], "isController": false}, "titles": ["Apdex", "T (Toleration threshold)", "F (Frustration threshold)", "Label"], "items": [{"data": [0.6666666666666666, 500, 1500, "Admin Login Page"], "isController": false}, {"data": [0.3333333333333333, 500, 1500, "Admin Reports"], "isController": false}, {"data": [0.5, 500, 1500, "Office Report"], "isController": false}, {"data": [1.0, 500, 1500, "Client Login Page"], "isController": false}, {"data": [1.0, 500, 1500, "Client Profile API"], "isController": false}, {"data": [0.0, 500, 1500, "Admin Dashboard"], "isController": false}, {"data": [0.5, 500, 1500, "Office Approvals"], "isController": false}, {"data": [0.3333333333333333, 500, 1500, "Client Survey Page"], "isController": false}, {"data": [0.5, 500, 1500, "Client History API"], "isController": false}, {"data": [0.5, 500, 1500, "Office Dashboard"], "isController": false}, {"data": [0.3333333333333333, 500, 1500, "User Accounts"], "isController": false}, {"data": [0.0, 500, 1500, "Survey Records"], "isController": false}, {"data": [0.0, 500, 1500, "Offices Management"], "isController": false}]}, function(index, item){
        switch(index){
            case 0:
                item = item.toFixed(3);
                break;
            case 1:
            case 2:
                item = formatDuration(item);
                break;
        }
        return item;
    }, [[0, 0]], 3);

    // Create statistics table
    createTable($("#statisticsTable"), {"supportsControllersDiscrimination": true, "overall": {"data": ["Total", 39, 0, 0.0, 1252.4871794871794, 68, 4070, 1004.0, 2356.0, 3898.0, 4070.0, 0.448121337469838, 65.19906255386074, 0.09378500947948983], "isController": false}, "titles": ["Label", "#Samples", "FAIL", "Error %", "Average", "Min", "Max", "Median", "90th pct", "95th pct", "99th pct", "Transactions/s", "Received", "Sent"], "items": [{"data": ["Admin Login Page", 3, 0, 0.0, 915.6666666666667, 193, 2356, 198.0, 2356.0, 2356.0, 2356.0, 0.05025883298989798, 2.350238493868422, 0.005938787882595366], "isController": false}, {"data": ["Admin Reports", 3, 0, 0.0, 1437.6666666666667, 1361, 1590, 1362.0, 1590.0, 1590.0, 1590.0, 0.050927733546098086, 6.026382157468553, 0.011040973483626735], "isController": false}, {"data": ["Office Report", 3, 0, 0.0, 904.3333333333334, 858, 947, 908.0, 947.0, 947.0, 947.0, 0.05142357599547472, 3.6902944160424416, 0.011650653936474742], "isController": false}, {"data": ["Client Login Page", 3, 0, 0.0, 72.66666666666667, 68, 81, 69.0, 81.0, 81.0, 81.0, 0.052174820431659684, 0.5454918237708481, 0.00652185255395746], "isController": false}, {"data": ["Client Profile API", 3, 0, 0.0, 308.3333333333333, 286, 325, 314.0, 325.0, 325.0, 325.0, 0.051955249212012056, 0.035414808544906654, 0.012024798889889509], "isController": false}, {"data": ["Admin Dashboard", 3, 0, 0.0, 3792.3333333333335, 3409, 4070, 3898.0, 4070.0, 4070.0, 4070.0, 0.048876651623519445, 15.113529388105054, 0.010739498647745972], "isController": false}, {"data": ["Office Approvals", 3, 0, 0.0, 717.6666666666666, 709, 727, 717.0, 727.0, 727.0, 727.0, 0.051553478141325264, 3.929694078438617, 0.01183112047188617], "isController": false}, {"data": ["Client Survey Page", 3, 0, 0.0, 1504.0, 1458, 1587, 1467.0, 1587.0, 1587.0, 1587.0, 0.050945030312293034, 18.195982745555046, 0.011542233430128892], "isController": false}, {"data": ["Client History API", 3, 0, 0.0, 553.0, 541, 567, 551.0, 567.0, 567.0, 567.0, 0.05172592158350288, 0.0366728701851788, 0.01197172208524432], "isController": false}, {"data": ["Office Dashboard", 3, 0, 0.0, 967.0, 914, 1004, 983.0, 1004.0, 1004.0, 1004.0, 0.051320651430135485, 5.228792542681675, 0.011777688560626796], "isController": false}, {"data": ["User Accounts", 3, 0, 0.0, 1491.6666666666667, 1382, 1596, 1497.0, 1596.0, 1596.0, 1596.0, 0.05082678232583356, 10.335358154098333, 0.01136653628185145], "isController": false}, {"data": ["Survey Records", 3, 0, 0.0, 1831.0, 1687, 1942, 1864.0, 1942.0, 1942.0, 1942.0, 0.05056378621631188, 15.868733250745816, 0.011357100419679425], "isController": false}, {"data": ["Offices Management", 3, 0, 0.0, 1787.0, 1697, 1927, 1737.0, 1927.0, 1927.0, 1927.0, 0.05063718457253776, 14.231274131783273, 0.011027433749683518], "isController": false}]}, function(index, item){
        switch(index){
            // Errors pct
            case 3:
                item = item.toFixed(2) + '%';
                break;
            // Mean
            case 4:
            // Mean
            case 7:
            // Median
            case 8:
            // Percentile 1
            case 9:
            // Percentile 2
            case 10:
            // Percentile 3
            case 11:
            // Throughput
            case 12:
            // Kbytes/s
            case 13:
            // Sent Kbytes/s
                item = item.toFixed(2);
                break;
        }
        return item;
    }, [[0, 0]], 0, summaryTableHeader);

    // Create error table
    createTable($("#errorsTable"), {"supportsControllersDiscrimination": false, "titles": ["Type of error", "Number of errors", "% in errors", "% in all samples"], "items": []}, function(index, item){
        switch(index){
            case 2:
            case 3:
                item = item.toFixed(2) + '%';
                break;
        }
        return item;
    }, [[1, 1]]);

        // Create top5 errors by sampler
    createTable($("#top5ErrorsBySamplerTable"), {"supportsControllersDiscrimination": false, "overall": {"data": ["Total", 39, 0, "", "", "", "", "", "", "", "", "", ""], "isController": false}, "titles": ["Sample", "#Samples", "#Errors", "Error", "#Errors", "Error", "#Errors", "Error", "#Errors", "Error", "#Errors", "Error", "#Errors"], "items": [{"data": [], "isController": false}, {"data": [], "isController": false}, {"data": [], "isController": false}, {"data": [], "isController": false}, {"data": [], "isController": false}, {"data": [], "isController": false}, {"data": [], "isController": false}, {"data": [], "isController": false}, {"data": [], "isController": false}, {"data": [], "isController": false}, {"data": [], "isController": false}, {"data": [], "isController": false}, {"data": [], "isController": false}]}, function(index, item){
        return item;
    }, [[0, 0]], 0);

});
